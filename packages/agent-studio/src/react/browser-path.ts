export function browserPath(): string {
  if (typeof window === "undefined") {
    return "/";
  }

  const value = window.location.hash.replace(/^#/u, "");
  return value.startsWith("/") ? value : "/";
}
