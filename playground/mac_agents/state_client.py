"""
GitHubStateClient: Handles all reads/writes to state.json via GitHub REST API.
Uses SHA-based optimistic locking to prevent conflicts between parallel agents.
"""

import json
import time
import base64
import os
import random
import requests
from typing import Optional, Tuple


STATE_FILE_PATH = "playground/mac_agents/state.json"


class GitHubStateClient:
    """
    Centralized GitHub API client for state management.
    All agents share this client for atomic, conflict-safe state reads/writes.
    Enforces SHA validation on every write to detect and recover from conflicts.
    """

    def __init__(self):
        self.token = os.environ["GITHUB_TOKEN"]
        self.repo = os.environ["GITHUB_REPOSITORY"]  # e.g. "owner/repo"
        self.base_url = f"https://api.github.com/repos/{self.repo}"
        self.headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    # ------------------------------------------------------------------
    # State File Operations
    # ------------------------------------------------------------------

    def get_state(self) -> Tuple[dict, str]:
        """
        Fetch the current state.json from the repository.

        Returns:
            (state_dict, sha) — the parsed state and the current file SHA.
            The SHA must be supplied back on any write to avoid 409 conflicts.
        """
        url = f"{self.base_url}/contents/{STATE_FILE_PATH}"
        response = requests.get(url, headers=self.headers, timeout=30)
        response.raise_for_status()
        data = response.json()
        content = base64.b64decode(data["content"]).decode("utf-8")
        return json.loads(content), data["sha"]

    def update_state(
        self,
        new_state: dict,
        sha: str,
        commit_message: str = "chore: update state.json",
        max_retries: int = 20,
    ) -> Tuple[dict, str]:
        """
        Write new_state to state.json using the provided SHA for conflict detection.

        If a 409 Conflict is returned (another agent wrote first), this method
        automatically re-fetches the latest state, merges the update shallowly,
        and retries up to max_retries times.

        Returns:
            (updated_state, new_sha) after a successful write.
        Raises:
            RuntimeError if all retries are exhausted.
        """
        url = f"{self.base_url}/contents/{STATE_FILE_PATH}"
        for attempt in range(1, max_retries + 1):
            payload = {
                "message": commit_message,
                "content": base64.b64encode(
                    json.dumps(new_state, ensure_ascii=False, indent=2).encode("utf-8")
                ).decode("utf-8"),
                "sha": sha,
            }
            response = requests.put(url, headers=self.headers, json=payload, timeout=30)

            if response.status_code in (200, 201):
                resp_data = response.json()
                return new_state, resp_data["content"]["sha"]

            if response.status_code == 409:
                jitter = random.uniform(0, 3)
                wait = 2 * attempt + jitter
                print(
                    f"[STATE_CLIENT] >> 409 Conflict on attempt {attempt}/{max_retries}. "
                    f"Retrying in {wait:.1f}s…"
                )
                time.sleep(wait)  # jittered exponential back-off
                current_state, sha = self.get_state()
                # Caller's intent is preserved — merge top-level keys only.
                # Each agent should re-apply its specific changes on top.
                new_state = self._shallow_merge(current_state, new_state)
            else:
                response.raise_for_status()

        raise RuntimeError(
            f"[STATE_CLIENT] >> Failed to update state after {max_retries} retries."
        )

    def initialize_state(self, objective: str, session_id: str, issue_number: int) -> Tuple[dict, str]:
        """
        Create or overwrite state.json with a fresh RUNNING state.
        Called once at the very start by the Planner.
        """
        import datetime

        initial_state = {
            "system": {
                "status": "RUNNING",
                "session_id": session_id,
                "start_time": datetime.datetime.utcnow().isoformat() + "Z",
                "issue_number": issue_number,
            },
            "control": {
                "current_owner": "PLANNER",
                "is_locked": False,
            },
            "payload": {
                "objective": objective,
                "current_plan": [],
                "worker_output": "",
                "validator_feedback": "",
                "user_intervention": "",
            },
            "watchdog": {
                "summary": "System initializing…",
                "last_beat": datetime.datetime.utcnow().isoformat() + "Z",
            },
        }

        # Try to get existing SHA (file may already exist from a prior run).
        try:
            _, existing_sha = self.get_state()
        except requests.HTTPError:
            existing_sha = None

        url = f"{self.base_url}/contents/{STATE_FILE_PATH}"
        payload = {
            "message": f"chore: initialize state for session {session_id}",
            "content": base64.b64encode(
                json.dumps(initial_state, ensure_ascii=False, indent=2).encode("utf-8")
            ).decode("utf-8"),
        }
        if existing_sha:
            payload["sha"] = existing_sha

        response = requests.put(url, headers=self.headers, json=payload, timeout=30)
        response.raise_for_status()
        new_sha = response.json()["content"]["sha"]
        return initial_state, new_sha

    # ------------------------------------------------------------------
    # Issue / Comment Operations
    # ------------------------------------------------------------------

    def get_issue_comments(self, issue_number: int) -> list:
        """Return all comments on the given issue, newest-last."""
        url = f"{self.base_url}/issues/{issue_number}/comments"
        params = {"per_page": 100, "sort": "created", "direction": "asc"}
        response = requests.get(url, headers=self.headers, params=params, timeout=30)
        response.raise_for_status()
        return response.json()

    def post_issue_comment(self, issue_number: int, body: str) -> dict:
        """Post a new comment to the given issue."""
        url = f"{self.base_url}/issues/{issue_number}/comments"
        response = requests.post(url, headers=self.headers, json={"body": body}, timeout=30)
        response.raise_for_status()
        return response.json()

    def update_issue_comment(self, comment_id: int, body: str) -> dict:
        """Edit an existing issue comment in-place."""
        url = f"{self.base_url}/issues/comments/{comment_id}"
        response = requests.patch(url, headers=self.headers, json={"body": body}, timeout=30)
        response.raise_for_status()
        return response.json()

    # ------------------------------------------------------------------
    # Self-Healing: Trigger Next Workflow
    # ------------------------------------------------------------------

    def trigger_next_workflow(self, event_type: str = "mac-infinite-loop-resume", payload: dict = None) -> None:
        """
        Send a repository_dispatch event to spawn the next generation workflow.
        Called by any agent when approaching the 5.5-hour wall.
        """
        url = f"{self.base_url}/dispatches"
        body = {
            "event_type": event_type,
            "client_payload": payload or {},
        }
        response = requests.post(url, headers=self.headers, json=body, timeout=30)
        response.raise_for_status()
        print(f"[STATE_CLIENT] >> repository_dispatch '{event_type}' sent successfully.")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _shallow_merge(base: dict, override: dict) -> dict:
        """Merge override into base at the top level only."""
        merged = {**base}
        for key, value in override.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key] = {**merged[key], **value}
            else:
                merged[key] = value
        return merged
