/** Convert only an unambiguous GitHub HTTPS repository URL, never a provider guess. */
export function githubSshRepository(
  repository: string | undefined,
): string | undefined {
  if (!repository || repository !== repository.trim()) return undefined;
  const match = repository.match(
    /^https:\/\/github\.com(?::443)?\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,104})\/?$/i,
  );
  if (!match) return undefined;
  const name = match[2].replace(/\.git$/, "");
  if (!name || name === "." || name === ".." || name.length > 100)
    return undefined;
  return `git@github.com:${match[1]}/${name}.git`;
}
