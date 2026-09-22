// Command registry. Each workstream adds its command file and registers it here (append-only).
export type Command = (args: string[]) => Promise<void>;
export const commands: Record<string, Command> = {
  version: async () => console.log("dev"),
};
