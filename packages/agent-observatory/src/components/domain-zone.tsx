import type { DomainLayout } from "../data/atom-layout.js";

export function DomainZone({ domain }: { readonly domain: DomainLayout }) {
  const domainClass = domain.key.startsWith("agent:") ? "domain-agent" : `domain-${domain.key}`;
  return (
    <section
      className={`domain-zone ${domainClass}`}
      style={{
        height: domain.height,
        left: domain.x,
        top: domain.y,
        width: domain.width,
      }}
    >
      <h2>{domain.label}</h2>
      <p>{domain.subtitle}</p>
    </section>
  );
}
