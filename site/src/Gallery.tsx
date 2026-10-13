import { artifactPages } from "./artifacts";
import { pickLocalized, useLang } from "./i18n";
import { ROUTES } from "./routes";

const accents = ["", "cyan", "green", "purple", "yellow", ""] as const;

export function Gallery() {
  const { lang, t } = useLang();
  return (
    <div className="content-inner">
      <div className="crumb">
        <a href={ROUTES.home}>Yiku</a> / {t.galleryCrumb}
      </div>

      <h1 className="page-title">{t.galleryTitle}</h1>
      <p className="page-desc">{t.galleryDesc("artifacts/")}</p>

      <div className="grid">
        {artifactPages.map((a, i) => (
          <a key={a.slug} href={ROUTES.artifact(a.slug)} className="card">
            <div className={`card-accent ${accents[i % accents.length]}`} />
            <div className="card-kicker">
              {a.tags.map((tag) => pickLocalized(tag, lang)).join(" · ")}
            </div>
            <div className="card-title">{pickLocalized(a.title, lang)}</div>
            <div className="card-body">{pickLocalized(a.description, lang)}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
