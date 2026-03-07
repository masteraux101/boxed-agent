---
name: "Generate LangGraph Planner Worker"
description: "Create a TypeScript LangGraph planner-worker collaboration system runnable in GitHub Actions"
argument-hint: "Prompt source (issue title/body, optional constraints, output file location)"
agent: "agent"
---
Create a complete LangGraph (TypeScript) planner-worker collaboration implementation in this workspace.

Requirements:
- Use `@langchain/langgraph` with `Annotation.Root` state.
- Implement Planner nodes: `parseTasks`, `factCheck`, `checkNewRequirements`, `assignTask`, `handleFeedback`, `shouldContinue`.
- Implement Worker nodes: `generateCode`, `syntaxCheck`, `runTests`, `packageFeedback`.
- Use async functions for all nodes and return partial state updates.
- Add `console.log` at node start and end for GitHub Action traceability.
- Build graph topology:
  - Planner cycle: `parseTasks -> factCheck -> checkNewRequirements -> (replan or assignTask)`
  - Worker subgraph: `generateCode -> syntaxCheck -> (runTests or packageFeedback) -> packageFeedback`
  - Planner continuation: `assignTask -> workerSubgraph -> handleFeedback -> (continue or end)`
- Add an `index.ts` entry reading env vars (`ISSUE_NUMBER`, `USER_PROMPT`) and invoking compiled graph.
- Add a GitHub Actions workflow that triggers on issue create/edit and issue comment events.
- Mock LLM/API integrations clearly with comments showing where real calls should be inserted.
- Handle error boundaries (task assignment failure, syntax failure, test failure).

Output format:
1. Show a concise implementation plan.
2. Create or update files directly.
3. Summarize created files with one-line purpose each.
4. Provide a short run/check section for local and CI execution.

Use existing project conventions and keep text/content in English inside code and workflow files.
