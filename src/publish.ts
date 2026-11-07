import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/workspaceFiles";

export function isNameCollision(error: unknown) {
  const failure = error as { code?: string; response?: { data?: { data?: { code?: string } } } } | null;
  return failure?.code === "EEXIST" || failure?.response?.data?.data?.code === "EEXIST";
}

function timestamp(now: Date) {
  const parts = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(value => String(value).padStart(2, "0"));
  return `${parts.slice(0, 3).join("")}_${parts.slice(3).join("")}`;
}

export async function publishExport(
  workspace: Pick<WorkspaceFiles, "write" | "rename" | "remove">,
  paths: { root: string; input: string; name: string; partial: string },
  sourceList: string,
  signal: AbortSignal,
) {
  const timestampedName = `${paths.name}_${timestamp(new Date())}`;
  for (let suffix = 0; ; suffix++) {
    signal.throwIfAborted();
    const basename = suffix === 0 ? timestampedName : `${timestampedName}_${suffix}`;
    const archive = `${paths.input}/${basename}.txt`;
    const output = `${paths.root}/${basename}.mp4`;
    let reserved = false;
    try {
      await workspace.write(archive, sourceList, true);
      reserved = true;
      signal.throwIfAborted();
      await workspace.rename(paths.partial, output);
      return output;
    } catch (error) {
      if (reserved) await workspace.remove(archive).catch(() => {});
      if (!isNameCollision(error)) throw error;
    }
  }
}
