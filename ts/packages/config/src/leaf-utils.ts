export function joinPath(root: string, child: string): string {
  if (root === "") return child;
  return `${root.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

export function nonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
