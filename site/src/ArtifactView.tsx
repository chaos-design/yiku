import { useEffect, useState } from "react";
import { artifactPages, getArtifact } from "./artifacts";
import { pickLocalized, useLang, useT } from "./i18n";
import { ROUTES } from "./routes";

export function ArtifactView({ slug }: { slug: string }) {
  const t = useT();
  const lang = useLang();
  const artifact = getArtifact(slug);
  const [immersive, setImmersive] = useState(false);

  // Esc exits immersive mode.
  useEffect(() => {
    if (!immersive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImmersive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [immersive]);

  if (!artifact) {
    return (
      <div className="content-inner">
        <div className="crumb">{t("artifact.crumb")}</div>
        <h1 className="page-title">{t("artifact.notfound.title")}</h1>
        <p className="page-desc">
          {t("artifact.notfound.desc", { slug })}{" "}
          <a href={ROUTES.gallery}>{t("artifact.notfound.link")}</a>
        </p>
      </div>
    );
  }

  const at = artifactPages.findIndex((x) => x.slug === slug);
  const prev = at > 0 ? artifactPages[at - 1] : null;
  const next = at >= 0 && at < artifactPages.length - 1 ? artifactPages[at + 1] : null;

  return (
    <div className="content-inner">
      <div className="crumb">
        <a href={ROUTES.home}>Yiku</a> / {t("artifact.crumb")} /{" "}
        {pickLocalized(artifact.title, lang)}
      </div>

      <h1 className="page-title">{pickLocalized(artifact.title, lang)}</h1>
      <p className="page-desc">{pickLocalized(artifact.description, lang)}</p>

      <div className="artifact-bar">
        <span className="pill">
          {artifact.tags.map((tag) => pickLocalized(tag, lang)).join(" · ")}
        </span>
        <span className="pill">{artifact.file}</span>
        <a className="open-link" href={artifact.file} target="_blank" rel="noreferrer">
          {t("artifact.open")}
        </a>
        <button className="btn primary" type="button" onClick={() => setImmersive(true)}>
          {t("artifact.fullscreen")}
        </button>
      </div>

      {!immersive ? (
        <iframe
          key={artifact.slug}
          className="artifact-frame"
          src={artifact.file}
          title={pickLocalized(artifact.title, lang)}
        />
      ) : null}

      {immersive ? (
        <div className="immersive">
          <div className="immersive-top">
            <span className="immersive-title">{pickLocalized(artifact.title, lang)}</span>
            <span className="pill">{t("artifact.exitEsc")}</span>
            <button className="btn" type="button" onClick={() => setImmersive(false)}>
              {t("artifact.exit")}
            </button>
          </div>
          <iframe
            className="immersive-frame"
            src={artifact.file}
            title={`${pickLocalized(artifact.title, lang)}${t("artifact.immersiveSuffix")}`}
          />
        </div>
      ) : null}

      {!immersive ? (
        <div className="pager">
          {prev ? (
            <a href={ROUTES.artifact(prev.slug)}>
              <span className="pager-kicker">{t("pager.prev")}</span>
              <span className="pager-title">{pickLocalized(prev.title, lang)}</span>
            </a>
          ) : (
            <a className="empty" href={ROUTES.gallery}>
              <span className="pager-kicker">{t("pager.back")}</span>
              <span className="pager-title">{t("pager.gallery")}</span>
            </a>
          )}
          {next ? (
            <a href={ROUTES.artifact(next.slug)}>
              <span className="pager-kicker">{t("pager.next")}</span>
              <span className="pager-title">{pickLocalized(next.title, lang)}</span>
            </a>
          ) : (
            <a className="empty" href={ROUTES.home}>
              <span className="pager-kicker">{t("pager.docsHome")}</span>
              <span className="pager-title">{t("pager.docsHomeTitle")}</span>
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}
