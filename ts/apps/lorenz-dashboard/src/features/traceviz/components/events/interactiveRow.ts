export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

export function eventTargetIsAnchor(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" && target instanceof Element && target.closest("a") != null;
}
