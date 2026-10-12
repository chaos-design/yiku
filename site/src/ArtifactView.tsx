import { useEffect, useState } from "react";
import { artifactPages, getArtifact } from "./artifacts";
import { pickLocalized, useLang } from "./i18n";
import { ROUTES } from "./routes";

export function ArtifactView({ slug }: { slug: string }) {
  const { lang, t } = useLang();
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
        <div className="crumb">{t.artifactCrumb}</div>
        <h1 className="page-title">{t.artifactNotFound}</h1>
        <p className="page-desc">
          {t.artifactNotFoundBody(slug)} <a href={ROUTES.gallery}>{t.browseAll}</a>。
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
        <a href={ROUTES.home}>Yiku</a> / {t.artifactCrumb} / {pickLocalized(artifact.title, lang)}
      </div>

      <h1 className="page-title">{pickLocalized(artifact.title, lang)}</h1>
      <p className="page-desc">{pickLocalized(artifact.description, lang)}</p>

      <div className="artifact-bar">
        <span className="pill">
          {artifact.tags.map((tag) => pickLocalized(tag, lang)).join(" · ")}
        </span>
        <span className="pill">{artifact.file}</span>
        <a className="open-link" href={artifact.file} target="_blank" rel="noreferrer">
          {t.openNewWindow}
        </a>
        <button className="btn primary" type="button" onClick={() => setImmersive(true)}>
          {t.fullscreen}
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
            <span className="pill">{t.escExit}</span>
            <button className="btn" type="button" onClick={() => setImmersive(false)}>
              {t.exitImmersive}
            </button>
          </div>
          <iframe
            className="immersive-frame"
            src={artifact.file}
            title={`${pickLocalized(artifact.title, lang)}${t.immersiveSuffix}`}
          />
        </div>
      ) : null}

      {!immersive ? (
        <div className="pager">
          {prev ? (
            <a href={ROUTES.artifact(prev.slug)}>
              <span className="pager-kicker">{t.pagerPrevArtifact}</span>
              <span className="pager-title">{pickLocalized(prev.title, lang)}</span>
            </a>
          ) : (
            <a className="empty" href={ROUTES.gallery}>
              <span className="pager-kicker">{t.pagerBack}</span>
              <span className="pager-title">{t.pagerGallery}</span>
            </a>
          )}
          {next ? (
            <a href={ROUTES.artifact(next.slug)}>
              <span className="pager-kicker">{t.pagerNextArtifact}</span>
              <span className="pager-title">{pickLocalized(next.title, lang)}</span>
            </a>
          ) : (
            <a className="empty" href={ROUTES.home}>
              <span className="pager-kicker">{t.pagerDocs}</span>
              <span className="pager-title">{t.pagerDocsTitle}</span>
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}
