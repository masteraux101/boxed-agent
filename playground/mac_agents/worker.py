"""
WorkerAgent: Physical executor.
- Receives the execution plan from Planner.
- Executes each step using Gemini (code writing, analysis, etc.).
- Stores output as a separate repo file to avoid state.json size limits.
- Writes a short reference into state and hands off to Validator.
"""

import base64
import datetime
import requests

from base_agent import BaseAgent

OUTPUT_FILE_PATH = "playground/mac_agents/worker_output.md"


class WorkerAgent(BaseAgent):
    ROLE = "WORKER"

    # ------------------------------------------------------------------
    # Core Execute
    # ------------------------------------------------------------------

    def execute(self, state: dict, sha: str) -> None:
        """
        Worker's turn:
        1. Read the current execution plan from state.
        2. For each step, call Gemini to perform the task.
        3. Aggregate outputs and hand off to VALIDATOR.
        """
        current_plan = state["payload"].get("current_plan", [])
        objective = state["payload"].get("objective", "")
        self.log(f"execute() called | sha={sha[:8]} | plan_steps={len(current_plan)} | objective='{objective[:120]}…'")

        if not current_plan:
            self.log("No plan to execute. Skipping — handing back to PLANNER.")
            state, sha = self.unlock_and_hand_off(
                state, sha, next_owner="PLANNER",
                commit_message="chore: [WORKER] no plan, returning to PLANNER",
            )
            return

        for idx, s in enumerate(current_plan, 1):
            self.log(f"  Plan step {idx}/{len(current_plan)}: {s[:100]}")

        # ---- Lock ----
        state, sha = self.lock_state(state, sha)
        self.log(f"Lock acquired (sha={sha[:8]}). Starting execution of {len(current_plan)}-step plan.")
        accumulated_output: list[str] = []

        for i, step in enumerate(current_plan, start=1):
            self.log(f"━━ Step {i}/{len(current_plan)} START ━━ {step}")
            # Read accumulated output from repo file so Gemini has full context
            full_prior = ""
            if accumulated_output:
                full_prior = self._read_prior_output(state)
                self.log(f"Prior context fetched: {len(full_prior)} chars (last 8000 of output file).")
            else:
                self.log("No prior context yet (first step).")
            result = self._execute_step(
                step=step,
                step_number=i,
                total_steps=len(current_plan),
                objective=objective,
                prior_output=full_prior,
            )
            accumulated_output.append(f"### Step {i}: {step}\n{result}")
            self.log(f"━━ Step {i}/{len(current_plan)} DONE ━━ Gemini output={len(result)} chars.")
            # Upload incrementally so future steps can read full context
            incremental_output = "\n\n".join(accumulated_output)
            try:
                last_output_sha = self._upload_output_file(incremental_output, state)
                self.log(f"Incremental upload done ({len(incremental_output)} total chars, sha={last_output_sha[:8]}).")
            except Exception as upload_exc:  # noqa: BLE001
                self.log(f"Warning: incremental upload failed for step {i}: {upload_exc}. Continuing.")
                last_output_sha = "unknown"

        # ---- Final: incremental uploads cover all steps; NO redundant re-upload ----
        full_output = "\n\n".join(accumulated_output)
        self.log(f"All {len(current_plan)} steps complete. Total chars: {len(full_output)}.")

        # Store only a short reference in state.json to avoid size limits
        state["payload"]["worker_output"] = (
            f"[OUTPUT STORED IN REPO FILE: {OUTPUT_FILE_PATH}]\n"
            f"Total chars: {len(full_output)}\n"
            f"Steps completed: {len(current_plan)}\n"
            f"Last-upload-sha: {last_output_sha}"
        )
        state, sha = self.unlock_and_hand_off(
            state, sha, next_owner="VALIDATOR",
            commit_message="chore: [WORKER] execution complete, hand off to VALIDATOR",
        )

    # ------------------------------------------------------------------
    # Step Execution via Gemini
    # ------------------------------------------------------------------

    def _execute_step(
        self,
        step: str,
        step_number: int,
        total_steps: int,
        objective: str,
        prior_output: str,
    ) -> str:
        prompt = self._build_worker_prompt(
            objective=objective,
            step=step,
            step_number=step_number,
            total_steps=total_steps,
            prior_output=prior_output,
        )
        return self.call_gemini(prompt)

    def _read_prior_output(self, state: dict) -> str:
        """Read the current worker_output.md from repo to use as context for next step."""
        url = f"{self.client.base_url}/contents/{OUTPUT_FILE_PATH}"
        self.log(f"_read_prior_output: fetching {OUTPUT_FILE_PATH}…")
        try:
            r = requests.get(url, headers=self.client.headers, timeout=20)
            self.log(f"_read_prior_output: GET status={r.status_code}")
            if r.status_code == 200:
                content = base64.b64decode(r.json()["content"]).decode("utf-8")
                trimmed = content[-8000:] if len(content) > 8000 else content
                self.log(f"_read_prior_output: file={len(content)} chars, passing last {len(trimmed)} chars to Gemini.")
                return trimmed
        except Exception as exc:  # noqa: BLE001
            self.log(f"_read_prior_output: ERROR — {exc}")
        return ""

    # ------------------------------------------------------------------
    # Output File Upload
    # ------------------------------------------------------------------

    def _upload_output_file(self, content: str, state: dict) -> str:
        """Upload worker output as a separate file in the repo. Returns SHA."""
        session_id = state["system"].get("session_id", "unknown")
        timestamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        file_content = f"# Worker Output\n**Session:** {session_id}  \n**Timestamp:** {timestamp}\n\n---\n\n{content}"

        encoded = base64.b64encode(file_content.encode("utf-8")).decode("utf-8")
        url = f"{self.client.base_url}/contents/{OUTPUT_FILE_PATH}"

        # Get existing SHA if file exists
        existing_sha = None
        try:
            r = requests.get(url, headers=self.client.headers, timeout=15)
            if r.status_code == 200:
                existing_sha = r.json()["sha"]
        except Exception:  # noqa: BLE001
            pass

        payload = {
            "message": f"chore: [WORKER] upload output for session {session_id}",
            "content": encoded,
        }
        if existing_sha:
            payload["sha"] = existing_shayu
            self.log(f"_upload_output_file: updating existing file (old_sha={existing_sha[:8]}) | {len(file_content)} chars encoded.")
        else:
            self.log(f"_upload_output_file: creating new file | {len(file_content)} chars encoded.")

        r = requests.put(url, headers=self.client.headers, json=payload, timeout=60)
        self.log(f"_upload_output_file: PUT status={r.status_code}")
        r.raise_for_status()
        new_sha = r.json()["content"]["sha"]
        self.log(f"_upload_output_file: SUCCESS → {OUTPUT_FILE_PATH} new_sha={new_sha[:8]}")
        return new_sha

    # ------------------------------------------------------------------
    # Prompt Construction
    # ------------------------------------------------------------------

    @staticmethod
    def _build_worker_prompt(
        objective: str,
        step: str,
        step_number: int,
        total_steps: int,
        prior_output: str,
    ) -> str:
        context_section = (
            f"\n## Code Written So Far (last part, continue from here)\n{prior_output[-6000:]}"
            if prior_output
            else ""
        )
        return f"""You are a Worker AI in a multi-agent software execution system.

## Overall Objective
{objective}

## Current Task (Step {step_number} of {total_steps})
{step}
{context_section}

## Instructions
Execute the current task thoroughly. If the task involves writing code, provide complete,
runnable code with comments. If it involves analysis, be specific and structured.
Think step-by-step before providing your response.

Produce your output now:
"""
