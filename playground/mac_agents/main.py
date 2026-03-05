"""
main.py — Entry point for each MAC-Infinite-Loop agent.

Usage (set by GHA workflow env vars):
    AGENT_ROLE=PLANNER  python main.py
    AGENT_ROLE=WORKER   python main.py
    AGENT_ROLE=VALIDATOR python main.py
    AGENT_ROLE=WATCHDOG python main.py

Required environment variables:
    GITHUB_TOKEN        — Personal access token with repo + issues scope
    GITHUB_REPOSITORY   — "owner/repo" (auto-set by GHA)
    GEMINI_API_KEY      — Google Gemini API key
    AGENT_ROLE          — Which agent to launch
    ISSUE_NUMBER        — GitHub Issue number for Watchdog reporting & user interventions
    OBJECTIVE           — (PLANNER only) The task objective text
    SESSION_ID          — Unique identifier for this run (used for resume tracking)
"""

import os
import sys


def main():
    role = os.environ.get("AGENT_ROLE", "").upper()
    if not role:
        print("ERROR: AGENT_ROLE environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    print(f"[MAIN] >> Starting agent: {role}")

    if role == "PLANNER":
        from planner import PlannerAgent

        # If this is the very first run, initialize state.json
        if os.environ.get("IS_FIRST_RUN", "false").lower() == "true":
            from state_client import GitHubStateClient
            import uuid

            client = GitHubStateClient()
            objective = os.environ.get("OBJECTIVE", "No objective provided.")
            session_id = os.environ.get("SESSION_ID", str(uuid.uuid4())[:8])
            issue_number = int(os.environ.get("ISSUE_NUMBER", "1"))

            print(f"[MAIN] >> Initializing state.json for session {session_id}.")
            client.initialize_state(
                objective=objective,
                session_id=session_id,
                issue_number=issue_number,
            )
            print("[MAIN] >> state.json initialized.")

        agent = PlannerAgent()

    elif role == "WORKER":
        from worker import WorkerAgent
        agent = WorkerAgent()

    elif role == "VALIDATOR":
        from validator import ValidatorAgent
        agent = ValidatorAgent()

    elif role == "WATCHDOG":
        from watchdog import WatchdogAgent
        agent = WatchdogAgent()

    else:
        print(f"ERROR: Unknown AGENT_ROLE '{role}'. Must be one of: PLANNER, WORKER, VALIDATOR, WATCHDOG", file=sys.stderr)
        sys.exit(1)

    agent.run()
    print(f"[MAIN] >> Agent {role} exited cleanly.")


if __name__ == "__main__":
    main()
