"""
PlannerAgent: Lifecycle manager.
- Decomposes the objective into sub-tasks using Gemini.
- Listens for user interventions via GitHub Issue comments.
- Is the ONLY agent allowed to set system.status = "COMPLETED".
"""

import json
import base64
import datetime
import requests

from base_agent import BaseAgent

OUTPUT_FILE_PATH = "playground/mac_agents/worker_output.md"


class PlannerAgent(BaseAgent):
    ROLE = "PLANNER"

    def __init__(self):
        super().__init__()
        self._last_seen_comment_id: int = 0  # track which comments were already processed

    # ------------------------------------------------------------------
    # Deadlock Detection (override run to add recovery)
    # ------------------------------------------------------------------

    def run(self) -> None:
        """Override run() to add deadlock recovery logic."""
        import time as _time
        from base_agent import POLL_INTERVAL_SECONDS as _POLL

        self.log("Entering Planner polling loop (with deadlock detection).")

        while True:
            if self._is_approaching_timeout():
                try:
                    state, sha = self.client.get_state()
                except Exception:  # noqa: BLE001
                    state, sha = {}, ""
                self._handle_timeout(state, sha)
                return

            try:
                state, sha = self.client.get_state()
            except Exception as exc:  # noqa: BLE001
                self.log(f"Error fetching state: {exc}. Retrying.")
                _time.sleep(_POLL)
                continue

            system_status = state.get("system", {}).get("status", "RUNNING")
            if system_status in ("COMPLETED", "FAILED"):
                self.log(f"System status '{system_status}'. Shutting down.")
                return

            if system_status == "RESUMING":
                _time.sleep(_POLL)
                continue

            control = state.get("control", {})
            current_owner = control.get("current_owner", "")
            is_locked = control.get("is_locked", False)

            # ---- Deadlock detection ----
            if is_locked and current_owner != "PLANNER":
                last_beat_str = state.get("watchdog", {}).get("last_beat", "")
                try:
                    last_beat_dt = datetime.datetime.fromisoformat(
                        last_beat_str.replace("Z", "+00:00")
                    )
                    now_utc = datetime.datetime.now(datetime.timezone.utc)
                    stale_minutes = (now_utc - last_beat_dt).total_seconds() / 60
                except Exception:  # noqa: BLE001
                    stale_minutes = 0

                if stale_minutes > 15:
                    self.log(
                        f"DEADLOCK DETECTED: is_locked=True for {stale_minutes:.1f} min "
                        f"by {current_owner}. Force-unlocking and returning to PLANNER."
                    )
                    state["control"]["is_locked"] = False
                    state["control"]["current_owner"] = "PLANNER"
                    state["payload"]["validator_feedback"] = (
                        "VALIDATION_FAIL\n"
                        f"(Deadlock recovery: {current_owner} was stuck for >15 min. "
                        "Replanning required.)"
                    )
                    try:
                        self.client.update_state(
                            state, sha,
                            commit_message=f"chore: [PLANNER] deadlock recovery from {current_owner}"
                        )
                        self.log("Dead lock cleared. Will begin replanning.")
                    except Exception as exc2:  # noqa: BLE001
                        self.log(f"Could not clear deadlock: {exc2}")
                    _time.sleep(_POLL)
                    continue

            # ---- Normal ownership check ----
            if current_owner == "PLANNER" and not is_locked:
                self.log("Ownership acquired. Entering execute().")
                try:
                    self.execute(state, sha)
                except Exception as exc:  # noqa: BLE001
                    self.log(f"Unhandled exception in execute(): {exc}")
            else:
                self.log(f"Not my turn (owner={current_owner}, locked={is_locked}). Sleeping.")

            _time.sleep(_POLL)

    # ------------------------------------------------------------------
    # Core Execute
    # ------------------------------------------------------------------

    def execute(self, state: dict, sha: str) -> None:
        """
        Planner's turn:
        1. Pull the latest user intervention from Issue comments.
        2. Decide whether the task is complete (COMPLETED) or needs replanning.
        3. If replanning: produce a fresh plan and hand off to WORKER.
        """
        # ---- Step 1: Lock so other agents know we're working ----
        state, sha = self.lock_state(state, sha)
        self.log("Lock acquired. Starting planner cycle.")

        # Each planning cycle is independent — reset chat history.
        self.reset_chat()

        # ---- Step 2: Sync user intervention from Issue comments ----
        intervention = self._sync_user_intervention(state, sha)
        if intervention:
            state["payload"]["user_intervention"] = intervention
            self.log(f"New user intervention detected: {intervention[:120]}…")
        else:
            self.log("No new user intervention.")

        # ---- Step 3: Check if validator approved AND no new user command ----
        validator_feedback = state["payload"].get("validator_feedback", "")
        self.log(
            f"execute() | sha={sha[:8]} | validator_feedback='{validator_feedback[:120].strip().replace(chr(10),' ')}' "
            f"| intervention={'yes: '+intervention[:60] if intervention else 'none'}"
        )
        if self._should_complete(validator_feedback, intervention):
            self.log("Validator approved and no new instructions. Publishing deliverables…")
            delivery_url = self._publish_deliverables(state)
            if delivery_url:
                issue_number = state["system"].get("issue_number", self.issue_number)
                self.client.post_issue_comment(
                    issue_number,
                    f"<!-- agent -->\n## ✅ Task Completed!\n\n"
                    f"All deliverables have been published to a dedicated repository:\n\n"
                    f"**➡️ {delivery_url}**\n\n"
                    f"The repository contains all generated source files extracted from the worker output."
                )
                self.log(f"Delivery published: {delivery_url}")
            else:
                self.log("Delivery publishing failed or no files extracted; marking COMPLETED anyway.")
            state["system"]["status"] = "COMPLETED"
            state["control"]["is_locked"] = False
            state["control"]["current_owner"] = "PLANNER"
            state["watchdog"]["summary"] = f"✅ Task completed. Deliverables: {delivery_url or '(none)'}"
            self.client.update_state(
                state, sha, commit_message="chore: [PLANNER] mark system COMPLETED"
            )
            return

        # ---- Step 4: Build context for Gemini ----
        objective = state["payload"].get("objective", "")
        current_plan = state["payload"].get("current_plan", [])
        worker_output_ref = state["payload"].get("worker_output", "")
        prior_feedback = validator_feedback

        # Read full worker output from repo file if stored there
        if worker_output_ref.strip().startswith("[OUTPUT STORED IN REPO FILE:"):
            self.log("Reading full worker output from repo file for replanning context.")
            worker_output = self._read_output_file()
        else:
            worker_output = worker_output_ref

        prompt = self._build_planning_prompt(
            objective=objective,
            current_plan=current_plan,
            prior_feedback=prior_feedback,
            worker_output=worker_output,
            user_intervention=intervention or state["payload"].get("user_intervention", ""),
        )

        # ---- Step 5: Call Gemini for a (re)plan ----
        self.log(f"Calling Gemini to (re)generate plan | prompt={len(prompt)} chars.")
        raw_plan = self.call_gemini(prompt)
        new_plan = self._parse_plan(raw_plan)
        self.log(f"New plan generated: {len(new_plan)} steps.")
        for idx, step in enumerate(new_plan, 1):
            self.log(f"  New plan step {idx}/{len(new_plan)}: {step[:100]}")

        # ---- Step 6: Update state and hand off to WORKER ----
        state["payload"]["current_plan"] = new_plan
        state["payload"]["validator_feedback"] = ""  # reset feedback for next cycle
        state["payload"]["worker_output"] = ""
        state["payload"]["user_intervention"] = ""  # consumed

        state, sha = self.unlock_and_hand_off(
            state, sha, next_owner="WORKER",
            commit_message="chore: [PLANNER] plan ready, hand off to WORKER",
        )
        self.log("Handed off to WORKER.")

    # ------------------------------------------------------------------
    # Output File Reader
    # ------------------------------------------------------------------

    def _read_output_file(self) -> str:
        """Fetch worker_output.md from repo and return decoded contents."""
        url = f"{self.client.base_url}/contents/{OUTPUT_FILE_PATH}"
        try:
            r = requests.get(url, headers=self.client.headers, timeout=30)
            r.raise_for_status()
            return base64.b64decode(r.json()["content"]).decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            self.log(f"Error reading output file: {exc}")
            return ""

    # ------------------------------------------------------------------
    # Deliverable Publisher
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_files_from_output(content: str) -> dict:
        """
        Parse worker_output.md and return {filename: code_string}.
        Handles PART N of M by concatenating parts in order.
        """
        import re
        step_pattern = re.compile(r'^### Step \d+: .+$', re.MULTILINE)
        step_positions = [(m.start(), m.group()) for m in step_pattern.finditer(content)]

        accumulator: dict = {}  # filename -> list of (part_num, code)

        for i, (pos, header) in enumerate(step_positions):
            end = step_positions[i + 1][0] if i + 1 < len(step_positions) else len(content)
            chunk = content[pos:end]

            # Extract target filename from step header
            fname_match = re.search(
                r'([\w\-]+\.(?:py|md|txt|json|yaml|yml|sh|js|ts|html|css|toml|cfg|ini))',
                header, re.IGNORECASE
            )
            if not fname_match:
                continue
            filename = fname_match.group(1)

            # Determine part number (default 1 for non-split files)
            part_match = re.search(r'PART\s+(\d+)\s+of\s+\d+', header, re.IGNORECASE)
            part_num = int(part_match.group(1)) if part_match else 1

            # Extract all fenced code blocks in this chunk
            code_blocks = re.findall(
                r'```(?:[a-zA-Z]*)\n(.*?)```', chunk, re.DOTALL
            )
            if not code_blocks:
                continue
            code = '\n'.join(code_blocks).strip()

            accumulator.setdefault(filename, []).append((part_num, code))

        # Sort parts and join
        result: dict = {}
        for filename, parts in accumulator.items():
            parts.sort(key=lambda x: x[0])
            result[filename] = '\n\n'.join(c for _, c in parts)
        return result

    def _publish_deliverables(self, state: dict) -> str:
        """
        Push every extracted source file into deliverables/<session_id>/ in the
        current repo. Returns the GitHub tree URL, or empty string on failure.
        """
        session_id = state.get("system", {}).get("session_id", "output")
        deliver_dir = f"deliverables/{session_id}"

        # 1. Read worker output
        raw = self._read_output_file()
        if not raw:
            self.log("_publish_deliverables: output file empty, skipping.")
            return ""

        # 2. Extract files
        files = self._extract_files_from_output(raw)
        if not files:
            self.log("_publish_deliverables: no extractable files found.")
            return ""
        self.log(f"Extracted {len(files)} file(s): {list(files.keys())}")

        # 3. Push each file into the current repo under deliverables/<session_id>/
        owner_repo = self.client.repo
        pushed = []
        for filename, code in files.items():
            file_path = f"{deliver_dir}/{filename}"
            file_api = f"{self.client.base_url}/contents/{file_path}"
            existing = requests.get(file_api, headers=self.client.headers, timeout=30)
            put_payload: dict = {
                "message": f"feat: [PLANNER] deliver {filename}",
                "content": base64.b64encode(code.encode("utf-8")).decode("ascii"),
            }
            if existing.status_code == 200:
                put_payload["sha"] = existing.json()["sha"]
            put_resp = requests.put(
                file_api, headers=self.client.headers,
                json=put_payload, timeout=30,
            )
            if put_resp.status_code in (200, 201):
                self.log(f"Delivered {file_path} ({len(code)} chars).")
                pushed.append(filename)
            else:
                self.log(f"Failed to deliver {filename}: {put_resp.status_code} {put_resp.text[:120]}")

        if not pushed:
            return ""

        return f"https://github.com/{owner_repo}/tree/main/{deliver_dir}"

    # ------------------------------------------------------------------
    # Issue Comment Sync
    # ------------------------------------------------------------------

    def _sync_user_intervention(self, state: dict, sha: str) -> str:
        """
        Fetch all issue comments and return the text of unprocessed user comments.
        Updates _last_seen_comment_id to avoid re-processing.
        """
        issue_number = state["system"].get("issue_number", self.issue_number)
        try:
            comments = self.client.get_issue_comments(issue_number)
        except Exception as exc:  # noqa: BLE001
            self.log(f"Could not fetch issue comments: {exc}")
            return ""

        new_comments = [
            c for c in comments
            if c["id"] > self._last_seen_comment_id
            and not c["body"].strip().startswith("<!-- agent -->")  # skip agent-posted comments
        ]

        if not new_comments:
            return ""

        self._last_seen_comment_id = new_comments[-1]["id"]
        combined = "\n---\n".join(
            f"@{c['user']['login']}: {c['body']}" for c in new_comments
        )
        return combined

    # ------------------------------------------------------------------
    # Completion Heuristic
    # ------------------------------------------------------------------

    @staticmethod
    def _should_complete(validator_feedback: str, new_intervention: str) -> bool:
        """
        Returns True only when the validator explicitly passed AND the user
        has not injected a new instruction in this cycle.
        """
        is_approved = (
            validator_feedback.strip().upper().startswith("PASS")
            or "VALIDATION_PASS" in validator_feedback.upper()
        )
        has_new_instruction = bool(new_intervention.strip())
        return is_approved and not has_new_instruction

    # ------------------------------------------------------------------
    # Prompt Construction
    # ------------------------------------------------------------------

    @staticmethod
    def _build_planning_prompt(
        objective: str,
        current_plan: list,
        prior_feedback: str,
        worker_output: str,
        user_intervention: str,
    ) -> str:
        plan_str = json.dumps(current_plan, indent=2, ensure_ascii=False) if current_plan else "None"
        return f"""You are a Planner AI in a multi-agent system executing a software task.

## Original Objective
{objective}

## Previous Execution Plan
{plan_str}

## Worker Output (latest)
{(worker_output or 'None')[:4000]}{'...(truncated, see repo file)' if len(worker_output or '') > 4000 else ''}

## Validator Feedback (latest)
{prior_feedback or "None"}

## User Intervention (latest)
{user_intervention or "None"}

## Your Task
Based on the above context, produce an updated, actionable execution plan.
Each step must be a clear, concrete instruction for the Worker agent.

## CRITICAL STEP-SIZE RULES (must follow):
1. Each step must produce NO MORE than 150-200 lines of code.
2. NEVER ask the Worker to write an entire file in one step if the file is large.
3. For large files, split them across MULTIPLE steps using clear "PART N of M" labels.
   Example for github_client.py (500+ lines):
   - Step 1: "Write PART 1 of 3 of github_client.py: imports, exception classes (GitHubError, RateLimitError, NotFoundError, AuthError), and TokenAuth class (~150 lines)"
   - Step 2: "Write PART 2 of 3 of github_client.py: GitHubClient class with __init__, request(), retry logic, rate-limit sleep (~150 lines). Continue from Part 1."
   - Step 3: "Write PART 3 of 3 of github_client.py: resource classes (ReposAPI, IssuesAPI, PullRequestsAPI, UsersAPI), PaginatedIterator (~150 lines). Continue from Part 2."
4. Do NOT include "verify", "check", or "finalize" steps — the Validator handles that.
5. Each step should produce output small enough to fit in a single API response.

If the validator reported errors, address them specifically in the new plan.
If the user provided new instructions, incorporate them.

Respond ONLY with a valid JSON array of step strings, e.g.:
["Step 1: …", "Step 2: …", "Step 3: …"]
Do NOT include any commentary outside the JSON.
"""

    # ------------------------------------------------------------------
    # Plan Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_plan(raw: str) -> list:
        """Extract JSON array from Gemini response, fall back gracefully."""
        raw = raw.strip()
        try:
            start = raw.index("[")
            end = raw.rindex("]") + 1
            return json.loads(raw[start:end])
        except (ValueError, json.JSONDecodeError):
            # Fall back: treat each non-empty line as a step
            return [line.strip() for line in raw.splitlines() if line.strip()]
