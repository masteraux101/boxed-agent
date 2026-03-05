"""
ValidatorAgent: AI-driven universal execution validator.

Phase 1 — Plan:  Ask Gemini what validation steps to run for THIS specific task and output.
                 Gemini returns a JSON array of shell commands tailored to the deliverable
                 (e.g. pytest, curl, python -c import, jq, diff …).

Phase 2 — Execute: Run each command literally via subprocess on the GHA runner.
                   Collect real stdout/stderr and exit codes.

Phase 3 — Verdict: All commands exit 0 → VALIDATION_PASS.
                   Any non-zero → VALIDATION_FAIL with full execution transcript.

This design is deliberately universal: Gemini decides the strategy; the agent executes it.
"""

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import requests

from base_agent import BaseAgent

OUTPUT_FILE_PATH = "playground/mac_agents/worker_output.md"

# Safety cap: never run more than this many commands in one validation cycle
MAX_COMMANDS = 20
# Per-command timeout (seconds)
COMMAND_TIMEOUT = 120


class ValidatorAgent(BaseAgent):
    ROLE = "VALIDATOR"

    # ------------------------------------------------------------------
    # Core Execute
    # ------------------------------------------------------------------

    def execute(self, state: dict, sha: str) -> None:
        worker_output_ref = state["payload"].get("worker_output", "")
        if not worker_output_ref.strip():
            self.log("No worker output to validate. Returning to PLANNER.")
            state, sha = self.unlock_and_hand_off(
                state, sha, next_owner="PLANNER",
                commit_message="chore: [VALIDATOR] no output, returning to PLANNER",
            )
            return

        self.log(f"execute() called | sha={sha[:8]}")

        # ---- Lock ----
        state, sha = self.lock_state(state, sha)
        self.log(f"Lock acquired (sha={sha[:8]}).")

        # ---- Read worker output ----
        if worker_output_ref.strip().startswith("[OUTPUT STORED IN REPO FILE:"):
            self.log(f"Fetching worker output from repo: {OUTPUT_FILE_PATH}")
            worker_output = self._read_output_file()
            if not worker_output:
                self._finish(state, sha, "VALIDATION_FAIL\nCould not read worker_output.md.")
                return
            self.log(f"Worker output: {len(worker_output)} chars / {worker_output.count(chr(10))} lines.")
        else:
            worker_output = worker_output_ref

        objective   = state["payload"].get("objective", "")
        current_plan = state["payload"].get("current_plan", [])

        # ---- Phase 1: Ask Gemini for a validation plan ----
        self.log("Phase 1: asking Gemini for a tailored validation plan…")
        plan_prompt = self._build_plan_prompt(objective, current_plan, worker_output)
        raw_plan = self.call_gemini(plan_prompt)
        commands = self._parse_commands(raw_plan)
        self.log(f"Gemini returned {len(commands)} validation command(s):")
        for i, c in enumerate(commands, 1):
            self.log(f"  [{i}] {c['desc']} → $ {c['cmd']}")

        if not commands:
            self._finish(
                state, sha,
                "VALIDATION_FAIL\nGemini returned no validation commands. Cannot validate."
            )
            return

        # ---- Phase 2: Extract files to tmp dir, then execute each command ----
        files = self._extract_files(worker_output)
        self.log(f"Extracted {len(files)} source file(s): {list(files.keys())}")

        with tempfile.TemporaryDirectory(prefix="mac_validator_") as tmpdir:
            # Write all extracted source files
            for fname, code in files.items():
                fpath = os.path.join(tmpdir, fname)
                os.makedirs(os.path.dirname(fpath), exist_ok=True)
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(code)
                self.log(f"  Wrote {fname} ({len(code)} chars)")

            # Install deps if requirements.txt present
            if "requirements.txt" in files:
                self.log("Installing dependencies…")
                r = subprocess.run(
                    [sys.executable, "-m", "pip", "install", "-r",
                     os.path.join(tmpdir, "requirements.txt"), "--quiet"],
                    capture_output=True, text=True, cwd=tmpdir, timeout=180,
                )
                outcome = "OK" if r.returncode == 0 else f"FAILED rc={r.returncode}"
                self.log(f"pip install: {outcome}")
                if r.returncode != 0:
                    self.log(r.stderr[:500])

            verdict, transcript = self._run_commands(commands, tmpdir)

        self.log(f"Verdict: {verdict}")
        self._finish(state, sha, f"{verdict}\n{transcript}")

    # ------------------------------------------------------------------
    # Phase 1 — Prompt Gemini for Validation Plan
    # ------------------------------------------------------------------

    @staticmethod
    def _build_plan_prompt(objective: str, plan: list, worker_output: str) -> str:
        plan_str = json.dumps(plan, indent=2, ensure_ascii=False) if plan else "[]"
        # Show Gemini the file names that were produced
        file_names = re.findall(
            r"### Step \d+:.*?([\w\-/]+\.(?:py|sh|js|ts|json|yaml|yml|toml|txt|md))",
            worker_output, re.IGNORECASE
        )
        unique_files = list(dict.fromkeys(file_names))
        return f"""You are a Validator Agent in a multi-agent software system running on a Linux GitHub Actions runner.
Your job is to decide HOW to validate the Worker's output for this specific task.

## Original Objective
{objective}

## Execution Plan That Was Followed
{plan_str}

## Files Produced by the Worker
{unique_files}

## Worker Output (first 4000 chars)
{worker_output[:4000]}

## Your Task
Return a JSON array of validation steps to execute on the Linux runner.
Each step is an object with:
  "cmd"  — the exact shell command to run (available: python3, pip, pytest, curl, bash, jq, node, etc.)
  "desc" — one-line human description of what this step checks

Rules:
- Prefer real execution over static review.
- For Python code: always include a syntax check (python3 -m py_compile) AND an import check.
  If test files exist (test_*.py), add a pytest command.
- For REST APIs / web services: include curl commands against any example endpoints.
- For data-processing scripts: run them against sample input and check the output.
- For shell scripts: run them with bash -n (syntax check) and/or execute them.
- NEVER add a step that just "reads" or "describes" — every step must run a real command.
- Maximum {MAX_COMMANDS} steps.
- Commands run in the directory where all extracted files were written.
  Use relative paths (e.g. "pytest test_foo.py", NOT "/tmp/xyz/test_foo.py").
- Use python3 (not python) and sys.executable path is available as the python interpreter.

Respond with ONLY a valid JSON array, no markdown, no commentary. Example:
[
  {{"cmd": "python3 -m py_compile github_client.py", "desc": "Syntax check github_client.py"}},
  {{"cmd": "python3 -c \\"import github_client; print('import OK')\\"", "desc": "Import check"}},
  {{"cmd": "pytest test_github_client.py -v --tb=short --no-header", "desc": "Run unit tests"}}
]
"""

    # ------------------------------------------------------------------
    # Parse Gemini's command list
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_commands(raw: str) -> list:
        """Extract JSON array of {cmd, desc} from Gemini response."""
        raw = raw.strip()
        try:
            start = raw.index("[")
            end   = raw.rindex("]") + 1
            items = json.loads(raw[start:end])
            # Validate shape
            result = []
            for item in items:
                if isinstance(item, dict) and "cmd" in item:
                    result.append({
                        "cmd":  str(item["cmd"]).strip(),
                        "desc": str(item.get("desc", item["cmd"])).strip(),
                    })
            return result[:MAX_COMMANDS]
        except (ValueError, json.JSONDecodeError):
            return []

    # ------------------------------------------------------------------
    # Phase 2 — Execute Commands
    # ------------------------------------------------------------------

    def _run_commands(self, commands: list, cwd: str) -> tuple:
        """
        Run each command, collect output.
        Returns ('VALIDATION_PASS'|'VALIDATION_FAIL', transcript).
        """
        transcript_parts: list = []
        all_passed = True

        for i, item in enumerate(commands, 1):
            cmd  = item["cmd"]
            desc = item["desc"]
            self.log(f"Running [{i}/{len(commands)}]: {desc} → $ {cmd}")

            # Replace bare "python " / "python3 " with sys.executable for portability
            cmd_exec = re.sub(r'\bpython3?\b', sys.executable, cmd, count=1)

            try:
                result = subprocess.run(
                    cmd_exec,
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=cwd,
                    timeout=COMMAND_TIMEOUT,
                )
                rc = result.returncode
                combined = (result.stdout + result.stderr).strip()
                status = "✅ PASS" if rc == 0 else f"❌ FAIL (rc={rc})"
                self.log(f"  → {status} | output={len(combined)} chars")

                block = (
                    f"--- [{i}] {desc} ---\n"
                    f"$ {cmd}\n"
                    f"Exit code: {rc}\n"
                    f"{combined[:2000]}"
                )
                transcript_parts.append(block)

                if rc != 0:
                    all_passed = False

            except subprocess.TimeoutExpired:
                self.log(f"  → ❌ TIMEOUT after {COMMAND_TIMEOUT}s")
                transcript_parts.append(
                    f"--- [{i}] {desc} ---\n$ {cmd}\nTIMEOUT after {COMMAND_TIMEOUT}s"
                )
                all_passed = False

            except Exception as exc:  # noqa: BLE001
                self.log(f"  → ❌ ERROR: {exc}")
                transcript_parts.append(
                    f"--- [{i}] {desc} ---\n$ {cmd}\nERROR: {exc}"
                )
                all_passed = False

        verdict = "VALIDATION_PASS" if all_passed else "VALIDATION_FAIL"
        transcript = "\n\n".join(transcript_parts)
        if all_passed:
            transcript = f"All {len(commands)} validation step(s) passed.\n\n" + transcript
        return verdict, transcript

    # ------------------------------------------------------------------
    # File Extraction (same logic as Planner._extract_files_from_output)
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_files(content: str) -> dict:
        step_pattern = re.compile(r"^### Step \d+: .+$", re.MULTILINE)
        step_positions = [(m.start(), m.group()) for m in step_pattern.finditer(content)]
        accumulator: dict = {}

        for i, (pos, header) in enumerate(step_positions):
            end = step_positions[i + 1][0] if i + 1 < len(step_positions) else len(content)
            chunk = content[pos:end]

            fname_match = re.search(
                r"([\w\-/]+\.(?:py|md|txt|json|yaml|yml|sh|js|ts|toml|cfg|ini))",
                header, re.IGNORECASE,
            )
            if not fname_match:
                continue
            filename = fname_match.group(1)

            part_match = re.search(r"PART\s+(\d+)\s+of\s+\d+", header, re.IGNORECASE)
            part_num = int(part_match.group(1)) if part_match else 1

            code_blocks = re.findall(r"```(?:[a-zA-Z]*)\n(.*?)```", chunk, re.DOTALL)
            if not code_blocks:
                continue
            code = "\n".join(code_blocks).strip()
            accumulator.setdefault(filename, []).append((part_num, code))

        result: dict = {}
        for filename, parts in accumulator.items():
            parts.sort(key=lambda x: x[0])
            result[filename] = "\n\n".join(c for _, c in parts)
        return result

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _finish(self, state: dict, sha: str, feedback: str) -> None:
        verdict = "PASS" if feedback.strip().startswith("VALIDATION_PASS") else "FAIL"
        state["payload"]["validator_feedback"] = feedback
        state, sha = self.unlock_and_hand_off(
            state, sha, next_owner="PLANNER",
            commit_message=f"chore: [VALIDATOR] verdict={verdict}, hand off to PLANNER",
        )
        self.log(f"Handed off to PLANNER (verdict={verdict}, sha={sha[:8]}).")

    def _read_output_file(self) -> str:
        url = f"{self.client.base_url}/contents/{OUTPUT_FILE_PATH}"
        try:
            r = requests.get(url, headers=self.client.headers, timeout=30)
            r.raise_for_status()
            return base64.b64decode(r.json()["content"]).decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            self.log(f"Error reading output file: {exc}")
            return ""

import base64
import os
import re
import subprocess
import sys
import tempfile
import requests

from base_agent import BaseAgent

OUTPUT_FILE_PATH = "playground/mac_agents/worker_output.md"


class ValidatorAgent(BaseAgent):
    ROLE = "VALIDATOR"

    # ------------------------------------------------------------------
    # Core Execute
    # ------------------------------------------------------------------

    def execute(self, state: dict, sha: str) -> None:
        """
        1. Read worker_output.md from the repo.
        2. Extract every source file from the Markdown code blocks.
        3. Write them to a temp directory on THIS runner.
        4. Run: pip install → py_compile check → pytest (or import check).
        5. PASS if everything exits 0; FAIL with full real output otherwise.
        """
        worker_output_ref = state["payload"].get("worker_output", "")
        if not worker_output_ref.strip():
            self.log("No worker output to validate. Returning to PLANNER.")
            state, sha = self.unlock_and_hand_off(
                state, sha, next_owner="PLANNER",
                commit_message="chore: [VALIDATOR] no output, returning to PLANNER",
            )
            return

        self.log(f"execute() called | sha={sha[:8]} | ref='{worker_output_ref[:80]}…'")

        # ---- Lock ----
        state, sha = self.lock_state(state, sha)
        self.log(f"Lock acquired (sha={sha[:8]}). Starting real-execution validation.")

        # ---- Read worker output ----
        if worker_output_ref.strip().startswith("[OUTPUT STORED IN REPO FILE:"):
            self.log(f"Fetching worker output from repo file: {OUTPUT_FILE_PATH}")
            worker_output = self._read_output_file()
            if not worker_output:
                self.log("Could not read output file. Failing.")
                self._finish(state, sha, "VALIDATION_FAIL\nCould not read worker_output.md from repo.")
                return
            self.log(f"Worker output: {len(worker_output)} chars / {worker_output.count(chr(10))} lines.")
        else:
            worker_output = worker_output_ref
            self.log(f"Worker output from state: {len(worker_output)} chars.")

        # ---- Extract files ----
        files = self._extract_files(worker_output)
        self.log(f"Extracted {len(files)} file(s): {list(files.keys())}")
        if not files:
            msg = (
                "VALIDATION_FAIL\n"
                "No source files could be extracted from worker_output.md.\n"
                "The Worker must wrap every file in a fenced code block (```python ... ```) "
                "with the filename mentioned in the step header."
            )
            self._finish(state, sha, msg)
            return

        # ---- Write to temp dir and execute ----
        with tempfile.TemporaryDirectory(prefix="mac_validator_") as tmpdir:
            self.log(f"Writing {len(files)} file(s) to {tmpdir}")
            for fname, code in files.items():
                fpath = os.path.join(tmpdir, fname)
                os.makedirs(os.path.dirname(fpath), exist_ok=True)
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(code)
                self.log(f"  Wrote {fname} ({len(code)} chars)")

            verdict, feedback = self._run_files(tmpdir, files)

        self.log(f"Verdict: {verdict}")
        self.log(f"Feedback (first 800):\n{feedback[:800]}")
        self._finish(state, sha, f"{verdict}\n{feedback}")

    def _finish(self, state: dict, sha: str, feedback: str) -> None:
        verdict = "PASS" if feedback.strip().startswith("VALIDATION_PASS") else "FAIL"
        state["payload"]["validator_feedback"] = feedback
        state, sha = self.unlock_and_hand_off(
            state, sha, next_owner="PLANNER",
            commit_message=f"chore: [VALIDATOR] verdict={verdict}, hand off to PLANNER",
        )
        self.log(f"Handed off to PLANNER (verdict={verdict}, sha={sha[:8]}).")

    # ------------------------------------------------------------------
    # File Extraction
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_files(content: str) -> dict:
        """
        Parse worker_output.md and return {filename: code_string}.
        Handles PART N of M by concatenating parts in order.
        """
        step_pattern = re.compile(r"^### Step \d+: .+$", re.MULTILINE)
        step_positions = [(m.start(), m.group()) for m in step_pattern.finditer(content)]

        accumulator: dict = {}  # filename -> list of (part_num, code)

        for i, (pos, header) in enumerate(step_positions):
            end = step_positions[i + 1][0] if i + 1 < len(step_positions) else len(content)
            chunk = content[pos:end]

            fname_match = re.search(
                r"([\w\-/]+\.(?:py|md|txt|json|yaml|yml|sh|js|ts|toml|cfg|ini))",
                header, re.IGNORECASE,
            )
            if not fname_match:
                continue
            filename = fname_match.group(1)

            part_match = re.search(r"PART\s+(\d+)\s+of\s+\d+", header, re.IGNORECASE)
            part_num = int(part_match.group(1)) if part_match else 1

            code_blocks = re.findall(r"```(?:[a-zA-Z]*)\n(.*?)```", chunk, re.DOTALL)
            if not code_blocks:
                continue
            code = "\n".join(code_blocks).strip()
            accumulator.setdefault(filename, []).append((part_num, code))

        result: dict = {}
        for filename, parts in accumulator.items():
            parts.sort(key=lambda x: x[0])
            result[filename] = "\n\n".join(c for _, c in parts)
        return result

    # ------------------------------------------------------------------
    # Real Execution
    # ------------------------------------------------------------------

    def _run_files(self, tmpdir: str, files: dict) -> tuple:
        """
        Determine the best execution strategy and run it.
        Returns ('VALIDATION_PASS'|'VALIDATION_FAIL', detail_string).
        """
        python = sys.executable
        py_files = [f for f in files if f.endswith(".py")]
        test_files = [f for f in py_files if os.path.basename(f).startswith("test")]
        non_test_py = [f for f in py_files if not os.path.basename(f).startswith("test")]

        results: list = []
        all_passed = True

        # ---- Step 1: install dependencies if requirements.txt present ----
        if "requirements.txt" in files:
            self.log("Installing dependencies from requirements.txt…")
            req_path = os.path.join(tmpdir, "requirements.txt")
            r = subprocess.run(
                [python, "-m", "pip", "install", "-r", req_path, "--quiet"],
                capture_output=True, text=True, cwd=tmpdir, timeout=120,
            )
            if r.returncode != 0:
                self.log(f"pip install failed (rc={r.returncode})")
                results.append(f"=== pip install FAILED (rc={r.returncode}) ===\n{r.stderr[:1000]}")
                all_passed = False
            else:
                self.log("Dependencies installed OK.")
                results.append("=== pip install: OK ===")

        # ---- Step 2: syntax check all .py files ----
        self.log(f"Syntax-checking {len(py_files)} Python file(s)…")
        for fname in py_files:
            fpath = os.path.join(tmpdir, fname)
            r = subprocess.run(
                [python, "-m", "py_compile", fpath],
                capture_output=True, text=True, timeout=30,
            )
            if r.returncode != 0:
                self.log(f"Syntax error in {fname} (rc={r.returncode})")
                results.append(f"=== SYNTAX ERROR: {fname} ===\n{r.stderr[:600]}")
                all_passed = False
            else:
                self.log(f"Syntax OK: {fname}")
                results.append(f"=== Syntax OK: {fname} ===")

        if not all_passed:
            return "VALIDATION_FAIL", "\n\n".join(results)

        # ---- Step 3: run pytest if test files present ----
        if test_files:
            self.log(f"Running pytest on: {test_files}")
            r = subprocess.run(
                [python, "-m", "pytest"]
                + [os.path.join(tmpdir, f) for f in test_files]
                + ["-v", "--tb=short", "--no-header"],
                capture_output=True, text=True, cwd=tmpdir, timeout=180,
            )
            combined = (r.stdout + r.stderr)[:3000]
            results.append(f"=== pytest (rc={r.returncode}) ===\n{combined}")
            self.log(f"pytest exit code: {r.returncode}")
            if r.returncode != 0:
                all_passed = False
        else:
            # ---- Step 4: import-check non-test Python files ----
            self.log(f"No test files. Import-checking {len(non_test_py)} module(s)…")
            for fname in non_test_py:
                module = os.path.splitext(fname)[0].replace("/", ".").replace("\\", ".")
                r = subprocess.run(
                    [python, "-c",
                     f"import sys; sys.path.insert(0,'.'); import {module}; print('OK')"],
                    capture_output=True, text=True, cwd=tmpdir, timeout=30,
                )
                if r.returncode != 0:
                    self.log(f"Import failed: {module} (rc={r.returncode})")
                    results.append(
                        f"=== IMPORT FAIL: {fname} (rc={r.returncode}) ===\n{r.stderr[:600]}"
                    )
                    all_passed = False
                else:
                    self.log(f"Import OK: {module}")
                    results.append(f"=== Import OK: {fname} ===")

        verdict = "VALIDATION_PASS" if all_passed else "VALIDATION_FAIL"
        detail = "\n\n".join(results)
        if all_passed:
            summary = (
                f"All {len(py_files)} Python file(s) passed syntax checks"
                + (f" and {len(test_files)} test file(s) passed pytest."
                   if test_files else " and import checks.")
            )
            detail = summary + "\n\n" + detail
        return verdict, detail

    # ------------------------------------------------------------------
    # Output File Reader
    # ------------------------------------------------------------------

    def _read_output_file(self) -> str:
        url = f"{self.client.base_url}/contents/{OUTPUT_FILE_PATH}"
        try:
            r = requests.get(url, headers=self.client.headers, timeout=30)
            r.raise_for_status()
            return base64.b64decode(r.json()["content"]).decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            self.log(f"Error reading output file: {exc}")
            return ""
