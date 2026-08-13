/**
 * Vault 内相对路径（posix）：从 fromFile 指向 targetPath。
 * Mention / Image / Attachment 共用（R006-C5 FR-50）。
 *
 * 例：学习/前端/React.md → assets/fiber.png => ../../assets/fiber.png
 */
export function relativeVaultPath(fromFile: string, targetPath: string): string {
  const fromParts = fromFile.split("/").slice(0, -1);
  const toParts = targetPath.split("/");
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length - 1 &&
    fromParts[i] === toParts[i]
  ) {
    i += 1;
  }
  const ups = fromParts.length - i;
  const down = toParts.slice(i);
  const rel = [...Array(ups).fill(".."), ...down].join("/");
  return rel || toParts[toParts.length - 1]!;
}
