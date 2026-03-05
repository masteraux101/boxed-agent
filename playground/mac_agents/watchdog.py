"""
WatchdogAgent: Real-time observer and user-facing reporter.
- NOT a participant in the control ownership competition.
- Continuously monitors state.json and posts progress summaries to GitHub Issues.
- Maintains a single "live status" comment which it edits in-place each cycle.
"""

import time
import datetime

from base_agent import BaseAgent, POLL_INTERVAL_SECONDS

# Watchdog posts / updates its issue comment every N seconds (independent cadence).
WATCHDOG_REPORT_INTERVAL = 90  # seconds — longer to reduce state.json conflict rate


class WatchdogAgent(BaseAgent):
    ROLE = "WATCHDOG"

    def __init__(self):
        super().__init__()
        self._live_comment_id: int | None = None  # ID of the pinned status comment
        self._last_reported_state: dict = {}
        self._last_report_time: float = 0.0

    # ------------------------------------------------------------------
    # Override run() — Watchdog never competes for ownership
    # ------------------------------------------------------------------

    def run(self) -> None:
        """
        Watchdog has its own run loop that ignores current_owner.
        It simply observes and reports, then sleeps.
        """
        self.log("Watchdog entering observation loop.")
        # Post an initial "I'm alive" comment
        self._post_or_update_status("🐕 Watchdog is online. Waiting for first state update…")

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
                self.log(f"Error fetching state: {exc}. Sleeping.")
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            system_status = state.get("system", {}).get("status", "RUNNING")

            # Check if it's time to report
            now = time.monotonic()
            should_report = (now - self._last_report_time) >= WATCHDOG_REPORT_INTERVAL

            if should_report:
                self.execute(state, sha)
                self._last_report_time = now

            if system_status in ("COMPLETED", "FAILED"):
                self.log(f"System is '{system_status}'. Watchdog shutting down.")
                # Post final summary
                self.execute(state, sha)
                return

            time.sleep(POLL_INTERVAL_SECONDS)

    # ------------------------------------------------------------------
    # Core Execute
    # ------------------------------------------------------------------

    def execute(self, state: dict, sha: str) -> None:
        """
        Summarize the current state and post/edit an Issue comment.
        Generates a Gemini-powered summary for rich reporting.
        """
        elapsed_s = int(time.monotonic() - self._start_time)
        since_last_s = int(time.monotonic() - self._last_report_time) if self._last_report_time else 0
        system_status = state.get("system", {}).get("status", "?")
        current_owner = state.get("control", {}).get("current_owner", "?")
        is_locked = state.get("control", {}).get("is_locked", False)
        plan_len = len(state.get("payload", {}).get("current_plan", []))
        worker_ref = state.get("payload", {}).get("worker_output", "")
        val_fb = state.get("payload", {}).get("validator_feedback", "")
        self.log(
            f"execute() | elapsed={elapsed_s}s | since_last_report={since_last_s}s | "
            f"status={system_status} owner={current_owner} locked={is_locked} "
            f"plan_steps={plan_len} worker_output={'yes' if worker_ref else 'no'} "
            f"validator_feedback={'yes' if val_fb else 'no'}"
        )

        # Each report is independent — reset chat so it doesn't carry old context.
        self.reset_chat()

        self.log("Generating Gemini status report…")
        summary = self._generate_summary(state)
        self.log(f"Summary generated: {len(summary)} chars.")

        # Store summary back into state for other agents to reference (best effort)
        try:
            current_state, current_sha = self.client.get_state()
            current_state["watchdog"]["summary"] = summary
            current_state["watchdog"]["last_beat"] = (
                datetime.datetime.utcnow().isoformat() + "Z"
            )
            self.client.update_state(
                current_state,
                current_sha,
                commit_message="chore: [WATCHDOG] heartbeat",
            )
            self.log(f"State heartbeat committed (sha={current_sha[:8]}).")
        except Exception as exc:  # noqa: BLE001
            self.log(f"Could not update state with summary: {exc}")

        self._post_or_update_status(summary)
        self.log(f"Status report posted/updated on Issue. live_comment_id={self._live_comment_id}")

    # ------------------------------------------------------------------
    # Summary Generation
    # ------------------------------------------------------------------

    def _generate_summary(self, state: dict) -> str:
        """Use Gemini to produce a readable Chinese+English progress report."""
        system_status = state.get("system", {}).get("status", "UNKNOWN")
        current_owner = state.get("control", {}).get("current_owner", "UNKNOWN")
        objective = state.get("payload", {}).get("objective", "")
        plan = state.get("payload", {}).get("current_plan", [])
        worker_output = state.get("payload", {}).get("worker_output", "")
        validator_feedback = state.get("payload", {}).get("validator_feedback", "")
        user_intervention = state.get("payload", {}).get("user_intervention", "")
        elapsed_min = int((time.monotonic() - self._start_time) / 60)

        plan_preview = "\n".join(f"  - {s}" for s in plan[:5]) if plan else "  (none yet)"
        if len(plan) > 5:
            plan_preview += f"\n  … and {len(plan)-5} more steps"

        # Determine if we are in a RE-PLANNING cycle (Planner is re-running after a FAIL)
        is_replanning = (
            current_owner == "PLANNER"
            and "VALIDATION_FAIL" in validator_feedback.upper()
        )
        replanning_section = ""
        if is_replanning:
            replanning_section = f"""
## ⚠️ REPLANNING in progress — Validator rejected the previous output
Full validator output (execution results / error detail):
```
{validator_feedback[:2000]}
```
"""

        prompt = f"""You are an observer in a multi-agent AI task system.
Produce a concise bilingual (Chinese + English) status report for the human user.
Be conversational, informative, and use Markdown formatting for GitHub Issues.

## System Snapshot
- Status: {system_status}
- Current Owner (active agent): {current_owner}
- Elapsed time: {elapsed_min} minutes
- Objective: {objective[:200]}
- Current Plan Preview:
{plan_preview}
- Latest Worker Output reference: {worker_output[:200] or "(none)"}
- Latest User Intervention: {user_intervention[:200] or "(none)"}
{replanning_section}
## Instructions
Write a status update for the GitHub Issue that:
1. Opens with a status badge emoji: ⏳ RUNNING / ✅ COMPLETED / ❌ FAILED / 🔄 REPLANNING
2. Gives a one-paragraph Chinese summary of what has happened so far
3. Lists what the current agent is doing right now
4. If REPLANNING: dedicate a section **"🔄 Why Replanning? / 重新规划原因"** that explains
   in plain language what the validator found wrong (syntax errors, failing tests, import errors, etc.)
   Include the specific file names and error messages from the validator output above.
5. Lists the upcoming planned steps
6. Notes any user interventions
7. Uses clear Markdown headers
Keep it under 500 words. Use <!-- agent --> as the very first line so bots can identify this comment.
"""
        try:
            return self.call_gemini(prompt)
        except Exception as exc:  # noqa: BLE001
            self.log(f"Gemini summary generation failed: {exc}. Using plain summary.")
            return self._plain_summary(state, elapsed_min, validator_feedback)

    @staticmethod
    def _plain_summary(state: dict, elapsed_min: int, validator_feedback: str = "") -> str:
        status = state.get("system", {}).get("status", "UNKNOWN")
        owner = state.get("control", {}).get("current_owner", "UNKNOWN")
        plan_len = len(state.get("payload", {}).get("current_plan", []))
        lines = [
            "<!-- agent -->",
            "## 🐕 Watchdog Status Report",
            f"- **Status**: {status}",
            f"- **Active Agent**: {owner}",
            f"- **Plan Steps**: {plan_len}",
            f"- **Elapsed**: {elapsed_min} min",
        ]
        if validator_feedback and "VALIDATION_FAIL" in validator_feedback.upper():
            lines.append(
                "\n### 🔄 Why Replanning? / 重新规划原因\n"
                f"```\n{validator_feedback[:1500]}\n```"
            )
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Issue Comment Management
    # ------------------------------------------------------------------

    def _post_or_update_status(self, body: str) -> None:
        """
        Post a new comment on first call; edit that same comment on all subsequent calls.
        This keeps the Issue thread clean with a single updating status block.
        """
        issue_number = int(self.issue_number)
        try:
            if self._live_comment_id is None:
                result = self.client.post_issue_comment(issue_number, body)
                self._live_comment_id = result["id"]
                self.log(f"Created live status comment #{self._live_comment_id}.")
            else:
                self.client.update_issue_comment(self._live_comment_id, body)
                self.log(f"Updated live status comment #{self._live_comment_id}.")
        except Exception as exc:  # noqa: BLE001
            self.log(f"Failed to post/update issue comment: {exc}")
