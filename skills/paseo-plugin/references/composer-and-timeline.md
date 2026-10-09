# Composer, Slash Commands, and Timeline Contributions

Reference guide for Paseo composer integrations, slash commands, composer pills, timeline transformations, and themes.

## Contents

- [Add a Composer Attachment Source](#add-a-composer-attachment-source)
- [Add a Client Slash Command](#add-a-client-slash-command)
- [Add a Composer Pill](#add-a-composer-pill)
- [Transform and Render Timeline Items](#transform-and-render-timeline-items)
- [Append a Timeline Row from the Daemon](#append-a-timeline-row-from-the-daemon)
- [Contribute a Theme](#contribute-a-theme)
- [Return to Paseo Plugins](../SKILL.md)

---

## Add a Composer Attachment Source

Define a search RPC and declarative source in `shared/`, handle it on the server, and register it on
the client:

```ts
// shared/issues.ts
import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const searchIssues = defineRpc({
  name: "issues.search",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

const issues = defineAttachmentSource({
  id: "issues",
  title: "Acme issue",
  icon: "CircleDot",
  pickerTitle: "Attach Acme issue",
  searchPlaceholder: "Search by identifier or title",
  search: searchIssues,
});
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { searchIssues } from "./shared/issues";

export default function contribute(server: PluginServerContext) {
  server.handle(searchIssues, ({ query }) => searchAcmeIssues(query));
  return () => {};
}
```

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { issues } from "./shared/issues";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(issues);
  return () => {};
}
```

Return complete text snapshots. Paseo owns the composer menu, picker, pills, drafts, and submission. Credentials and vendor calls stay in the daemon handler.

## Add a Client Slash Command

A slash command runs plugin code in the app when the user submits `/name args`. Nothing is sent to the agent. `args` is the raw text after the command name, trimmed; parse it in the plugin.

```ts
client.addSlashCommand({
  name: "review",
  description: "Run the review bot",
  argumentHint: "[scope]",
  context: "agent", // or "workspace" so drafts get it too
  async onSubmit({ args, agent, rpc, openPanel }) {
    await rpc(startReview, { agentId: agent.id, scope: args });
    openPanel("review");
  },
});
```

The callback receives the same context as the matching Command Center item plus `args`. Paseo owns the autocomplete row, input clearing, and the error toast; put pending UI in a pill or panel. Precedence is built-in client commands, then plugin commands, then provider commands; a lower-precedence collision is dropped. Commands do not run while the composer has attachments. Server-side slash commands do not exist.

## Add a Composer Pill

A pill is a per-agent button in the composer track bar next to Tasks and Subagents. Add and remove pills from the client entry lifecycle. `addComposerPill` exists on `PluginClientContext`.

```tsx
export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, () => void>();
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const { id: agentId, workspaceId } = update.agent;
    pills.get(agentId)?.();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "review",
        title: "Open review",
        workspaceId,
        agentId,
        Component: ReviewPill,
        async onPress() {
          client.openPanel("review", { workspaceId, agentId });
        },
      }),
    );
  });
  return () => {
    unsubscribe();
    for (const remove of pills.values()) remove();
  };
}
```

Call `contributeClient(client)` from `index.client.tsx`, or move its body into that entry. The component owns its icon and text; Paseo owns the pressable, chrome, pending state, error reporting, and placement. Removal functions are idempotent, and Paseo removes every pill when the plugin, client entrypoint, or host connection is torn down.

## Transform and Render Timeline Items

Timeline transformers and renderers are client contributions. A transformer selects one built-in `AgentTimelineItem.type`, inspects the item, and returns zero or more versioned plugin items. `undefined` keeps the source item, `items` replaces it, `[]` removes it. A renderer draws one `kind` and `version` after validating `data` with its Zod schema.

```ts
client.addTimelineTransformer({
  id: "inline-thinking",
  query: { itemType: "reasoning" },
  transform: ({ item, phase }) => ({
    items: [
      { type: "plugin", kind: "inline-thinking", version: 1, data: { text: item.text, phase } },
    ],
  }),
});
client.addTimelineRenderer({
  kind: "inline-thinking",
  version: 1,
  schema: z.object({ text: z.string(), phase: z.enum(["streaming", "complete"]) }),
  Component: InlineThinking,
});
```

Transformers run while the render model is built, on fetched history and on every live update, so `phase` is `"streaming"` for a loading thought or running tool call. Identity comes from the source item, so a streaming item keeps its mounted component; set an output `id` when one source explodes into several items. Transformers must be synchronous and deterministic, `data` must be JSON, and a transformer that throws is logged and skipped. Use `useRevealedText(text, phase)` from `@getpaseo/plugin/client/react-native` to pace streaming text. `plugin-examples/inline-thinking` replaces the thinking row with inline text; `plugin-examples/timeline-items` replaces a Pi todo tool call with a task card.

## Append a Timeline Row from the Daemon

A server handler can push a plugin-owned row into any agent timeline. The same renderer registration draws it.

```ts
server.handle(publishReview, async ({ agentId, verdict }, { paseo }) => {
  await paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    id: "review",
    kind: "review-result",
    version: 1,
    data: { verdict },
  });
  return {};
});
```

The daemon stamps `pluginId` from the plugin session, so only plugin code can call this. Re-appending with the same `id` replaces the earlier row live and on refetch, which is how a plugin updates a row. `data` is capped at 64 KiB serialized and rejected above that. Rows live in the daemon's in-memory timeline and survive scroll, refetch, and reconnect, but not a daemon restart. A row whose plugin is missing renders an unavailable placeholder. Hosts advertise support through `server_info.features.pluginTimelineItems`.

## Contribute a Theme

`addTheme` takes a small light or dark palette; Paseo expands it into the full token set. Every color is a hex string.

```ts
client.addTheme({
  id: "mocha",
  name: "Catppuccin Mocha",
  appearance: "dark",
  colors: {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    raised: "#313244",
    control: "#45475a",
    border: "#45475a",
    accent: "#cba6f7",
    mutedForeground: "#a6adc8",
    ring: "#6c7086",
  },
});
```

It appears under Settings → Appearance. A client that predates `addTheme` cannot evaluate the entry and reports `client.addTheme is not a function`; update the client. See `plugin-examples/catppuccin`.
