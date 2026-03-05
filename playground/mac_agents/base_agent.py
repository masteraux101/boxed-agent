"""
BaseAgent: Shared polling loop logic for all MAC-Infinite-Loop agents.
Every agent inherits from this class and overrides `execute()`.
"""

import os
import time
import datetime
import random
from abc import ABC, abstractmethod

import google.generativeai as genai

from state_client import GitHubStateClient


# GitHub Actions 6-hour wall = 21600 seconds. We bail at 5.5 h = 19800 s.
MAX_RUNTIME_SECONDS = 19_800
POLL_INTERVAL_SECONDS = 30


class BaseAgent(ABC):
    """
    Base class providing:
    - Shared Gemini client (google-generativeai)
    - GitHub state polling loop
    - Self-healing trip-wire (triggers next workflow before GHA timeout)
    - Uniform log format: [AGENT_NAME] >> [ACTION_DESCRIPTION]
    """

    ROLE: str = "BASE"  # Override in subclass

    def __init__(self):
        self.client = GitHubStateClient()

        # Gemini setup — uses official google-generativeai SDK
        genai.configure(api_key=os.environ["GEMINI_API_KEY"])
        self.model = genai.GenerativeModel(
            model_name=os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview"),
            generation_config={
                "temperature": 0.4,
                "max_output_tokens": 65536,
            },
        )

        self._start_time = time.monotonic()
        self.issue_number = int(os.environ.get("ISSUE_NUMBER", "1"))

        # Start a persistent chat session so all Gemini calls within this
        # agent's lifetime share conversation history (multi-turn context).
        self.chat = self.model.start_chat(history=[])
        self.log(f"Agent initialized. Watching issue #{self.issue_number}. Chat session started.")

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    def log(self, message: str) -> None:
        """Print a standardized log line: [ROLE] >> message"""
        ts = datetime.datetime.utcnow().strftime("%H:%M:%S")
        print(f"[{self.ROLE}] [{ts}] >> {message}", flush=True)

    # ------------------------------------------------------------------
    # Self-healing watchdog
    # ------------------------------------------------------------------

    def _is_approaching_timeout(self) -> bool:
        elapsed = time.monotonic() - self._start_time
        return elapsed >= MAX_RUNTIME_SECONDS

    def _handle_timeout(self, state: dict, sha: str) -> None:
        """
        Called when we are within ~30 minutes of the GHA 6-hour limit.
        Saves current state and fires a repository_dispatch to resume in a new job.
        """
        self.log(
            "Approaching 5.5-hour runtime limit. Triggering self-healing dispatch and exiting."
        )
        # Persist a checkpoint marker so the next generation knows where to resume
        state["system"]["status"] = "RESUMING"
        state["watchdog"]["summary"] = (
            f"[{self.ROLE}] Workflow nearing timeout. Auto-resuming via repository_dispatch."
        )
        try:
            self.client.update_state(
                state,
                sha,
                commit_message=f"chore: [{self.ROLE}] checkpoint before timeout",
            )
        except Exception as exc:  # noqa: BLE001
            self.log(f"Warning: could not write timeout checkpoint: {exc}")

        self.client.trigger_next_workflow(
            event_type="mac-infinite-loop-resume",
            payload={
                "session_id": state["system"].get("session_id", ""),
                "issue_number": self.issue_number,
                "resuming_from": self.ROLE,
            },
        )

    # ------------------------------------------------------------------
    # Main Loop
    # ------------------------------------------------------------------

    def run(self) -> None:
        """
        Primary entry-point for every agent.
        Polls state.json every POLL_INTERVAL_SECONDS seconds.
        Exits cleanly when system.status == 'COMPLETED' or 'FAILED'.
        """
        self.log("Entering polling loop.")
        poll_count = 0

        while True:
            poll_count += 1
            elapsed_s = int(time.monotonic() - self._start_time)

            # ---- Self-healing trip-wire ----
            if self._is_approaching_timeout():
                self.log(f"Poll #{poll_count} | elapsed={elapsed_s}s | APPROACHING TIMEOUT — triggering self-heal.")
                try:
                    state, sha = self.client.get_state()
                except Exception as exc:  # noqa: BLE001
                    self.log(f"Could not fetch state for timeout checkpoint: {exc}")
                    state, sha = {}, ""
                self._handle_timeout(state, sha)
                return

            # ---- Fetch current state ----
            try:
                state, sha = self.client.get_state()
            except Exception as exc:  # noqa: BLE001
                self.log(f"Poll #{poll_count} | elapsed={elapsed_s}s | Error fetching state: {exc}. Retrying in {POLL_INTERVAL_SECONDS}s.")
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            system_status = state.get("system", {}).get("status", "RUNNING")
            control = state.get("control", {})
            current_owner = control.get("current_owner", "")
            is_locked = control.get("is_locked", False)
            self.log(
                f"Poll #{poll_count} | elapsed={elapsed_s}s | "
                f"status={system_status} owner={current_owner} locked={is_locked} sha={sha[:8]}"
            )

            # ---- Global stop signals ----
            if system_status in ("COMPLETED", "FAILED"):
                self.log(f"System status is '{system_status}'. Shutting down cleanly.")
                return

            if system_status == "RESUMING":
                self.log("System in RESUMING state — waiting for next generation to start.")
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            # ---- Ownership check ----
            if current_owner == self.ROLE and not is_locked:
                self.log(f"Ownership acquired (sha={sha[:8]}). Entering execute().")
                try:
                    self.execute(state, sha)
                except Exception as exc:  # noqa: BLE001
                    self.log(f"Unhandled exception in execute(): {exc}")
                    # Do NOT crash — log and continue polling to stay resilient
            else:
                self.log(
                    f"Not my turn (owner={current_owner}, locked={is_locked}). Sleeping {POLL_INTERVAL_SECONDS}s."
                )

            time.sleep(POLL_INTERVAL_SECONDS)

    # ------------------------------------------------------------------
    # Abstract Interface
    # ------------------------------------------------------------------

    @abstractmethod
    def execute(self, state: dict, sha: str) -> None:
        """
        Called when current_owner == ROLE and is_locked == False.
        Subclasses must implement their specific logic here.
        """
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Shared Helpers
    # ------------------------------------------------------------------

    def call_gemini(self, prompt: str) -> str:
        """
        Send a prompt using the persistent chat session so every call within
        this agent's lifetime carries full conversation history (multi-turn).
        """
        history_len = len(self.chat.history)
        self.log(
            f"Calling Gemini | model={os.environ.get('GEMINI_MODEL','gemini-3-flash-preview')} "
            f"| prompt={len(prompt)} chars | history_turns={history_len} "
            f"| first_80='{prompt[:80].strip()}…'"
        )
        response = self.chat.send_message(prompt)
        text = response.text
        self.log(
            f"Gemini response received | {len(text)} chars | history_turns_now={len(self.chat.history)} "
            f"| first_150='{text[:150].strip().replace(chr(10),' ')}…'"
        )
        return text

    def reset_chat(self) -> None:
        """Reset the conversation history (e.g. between independent planning cycles)."""
        self.chat = self.model.start_chat(history=[])
        self.log("Chat session reset (history cleared).")

    def lock_state(self, state: dict, sha: str) -> tuple[dict, str]:
        """
        Set is_locked=True atomically before starting heavy work.
        Fetches the latest SHA to avoid conflicts with concurrent Watchdog commits.
        """
        self.log(f"lock_state: fetching fresh SHA (caller sha={sha[:8]})…")
        try:
            fresh_state, fresh_sha = self.client.get_state()
        except Exception:  # noqa: BLE001
            self.log("lock_state: get_state failed, falling back to caller state.")
            fresh_state, fresh_sha = state, sha

        self.log(f"lock_state: using fresh_sha={fresh_sha[:8]} (was {sha[:8]}). Committing lock.")
        fresh_state["control"]["is_locked"] = True
        result = self.client.update_state(
            fresh_state, fresh_sha, commit_message=f"chore: [{self.ROLE}] acquire lock"
        )
        self.log("lock_state: lock committed successfully.")
        return result

    def unlock_and_hand_off(
        self, state: dict, sha: str, next_owner: str, commit_message: str = ""
    ) -> tuple[dict, str]:
        """
        Release the lock and transfer ownership to next_owner.
        Always fetches the freshest state.json SHA immediately before writing
        to minimise 409 Conflict probability against concurrent Watchdog heartbeats.
        """
        msg = commit_message or f"chore: [{self.ROLE}] hand off to {next_owner}"
        self.log(f"unlock_and_hand_off → {next_owner} | payload_keys={list(state.get('payload',{}).keys())}")

        # Take the caller's desired payload fields
        caller_payload_updates = {
            k: v for k, v in state.get("payload", {}).items()
        }

        # Always fetch the LATEST state so we use a fresh SHA
        for attempt in range(1, 25):
            try:
                fresh_state, fresh_sha = self.client.get_state()
            except Exception as exc:  # noqa: BLE001
                self.log(f"unlock_and_hand_off: get_state failed (attempt {attempt}/24): {exc}")
                time.sleep(2 * attempt)
                continue

            self.log(f"unlock_and_hand_off: attempt {attempt}/24 | fresh_sha={fresh_sha[:8]} | committing…")
            # Apply unlock + ownership
            fresh_state["control"]["is_locked"] = False
            fresh_state["control"]["current_owner"] = next_owner
            # Apply payload updates from caller
            for k, v in caller_payload_updates.items():
                fresh_state["payload"][k] = v

            try:
                result = self.client.update_state(fresh_state, fresh_sha, commit_message=msg, max_retries=3)
                self.log(f"unlock_and_hand_off: SUCCESS on attempt {attempt}. Owner now={next_owner}.")
                return result
            except RuntimeError as rte:
                sleep_t = random.uniform(1, 5)
                self.log(f"unlock_and_hand_off: conflict on attempt {attempt}: {rte}. Sleeping {sleep_t:.1f}s…")
                time.sleep(sleep_t)

        raise RuntimeError(f"[{self.ROLE}] unlock_and_hand_off exhausted all retries.")
