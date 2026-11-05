// Starter content for new pages. Plain markdown, editable by users after creation.
const TEMPLATES = {
  blank: { name: 'Blank page', icon: '📄', title: 'Untitled', content: '' },

  docs: {
    name: 'Project documentation', icon: '📘', title: 'Project documentation',
    content: `## Overview
What this project is, who it is for, and why it exists.

## Goals
- [ ] Goal one
- [ ] Goal two

## Scope
**In scope**
-

**Out of scope**
-

## Architecture
Describe the main components and how they fit together.

## Roadmap and milestones
Link milestones and tasks here, for example FORGE-1.

## Team and responsibilities
| Person | Role | Owns |
|---|---|---|
|  |  |  |

## Links and resources
-
`,
  },

  meeting: {
    name: 'Meeting notes', icon: '🗓️', title: 'Meeting notes',
    content: `**Date:**
**Attendees:**

## Agenda
1.

## Discussion
-

## Decisions
-

## Action items
- [ ] Task, owner, due date
`,
  },

  requirements: {
    name: 'Requirements (PRD)', icon: '📋', title: 'Requirements',
    content: `## Problem
What problem are we solving, and for whom?

## Goals and success measures
-

## User stories
- As a ..., I want ..., so that ...

## Functional requirements
| ID | Requirement | Priority |
|---|---|---|
| R1 |  | High |

## Non-functional requirements
Performance, security, accessibility, and so on.

## Open questions
-
`,
  },

  decision: {
    name: 'Decision record', icon: '⚖️', title: 'Decision record',
    content: `**Status:** Proposed
**Date:**
**Deciders:**

## Context
What is the situation and what forces are at play?

## Options considered
1. **Option A**: pros / cons
2. **Option B**: pros / cons

## Decision
What we decided and why.

## Consequences
What becomes easier or harder because of this.
`,
  },

  retro: {
    name: 'Sprint retrospective', icon: '🔁', title: 'Sprint retrospective',
    content: `**Sprint:**
**Date:**

## What went well
-

## What did not go well
-

## What we will try next sprint
- [ ]

## Shout-outs
-
`,
  },
};

const list = () => Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, icon: t.icon }));

module.exports = { TEMPLATES, list };
