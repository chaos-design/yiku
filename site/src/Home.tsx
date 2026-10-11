import { artifactPages } from "./artifacts";
import { docCatalog } from "./docs";
import { pickLocalized, useLang, useT } from "./i18n";
import { ROUTES } from "./routes";

const accents = ["blue", "cyan", "green", "purple", "yellow", "red"] as const;

export function Home() {
  const t = useT();
  const lang = useLang();
  const sections = docCatalog.sections;
  const totalDocs = docCatalog.sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="content-inner">
      <div className="crumb">{t("home.crumb")}</div>

      <div className="hero">
        <div className="hero-kicker">Agent Runtime · Local Platform</div>
        <h1>{t("hero.title")}</h1>
        <p>{t("hero.desc")}</p>
        <div className="hero-actions">
          <a href={ROUTES.doc("README")} className="btn primary">
            {t("hero.primary")}
          </a>
          <a href={ROUTES.gallery} className="btn">
            {t("hero.secondary")}
          </a>
        </div>
      </div>

      <div className="grid" style={{ marginBottom: 8 }}>
        <a href={ROUTES.doc("README")} className="card">
          <div className="card-accent" />
          <div className="card-kicker">{t("card.docs.kicker")}</div>
          <div className="card-title">{t("card.docs.title")}</div>
          <div className="card-body">{t("card.docs.body", { n: totalDocs })}</div>
        </a>
        <a href={ROUTES.gallery} className="card">
          <div className="card-accent cyan" />
          <div className="card-kicker">{t("card.gallery.kicker")}</div>
          <div className="card-title">{t("card.gallery.title")}</div>
          <div className="card-body">{t("card.gallery.body")}</div>
        </a>
        <a href={ROUTES.doc("architecture/system-overview")} className="card">
          <div className="card-accent green" />
          <div className="card-kicker">{t("card.overview.kicker")}</div>
          <div className="card-title">{t("card.overview.title")}</div>
          <div className="card-body">{t("card.overview.body")}</div>
        </a>
        <a href={ROUTES.artifact("architecture-share")} className="card">
          <div className="card-accent purple" />
          <div className="card-kicker">{t("card.share.kicker")}</div>
          <div className="card-title">{t("card.share.title")}</div>
          <div className="card-body">{t("card.share.body")}</div>
        </a>
      </div>

      {sections.map((section, i) => (
        <div key={section.id}>
          <div className="section-head">
            <h2>{pickLocalized(section.title, lang)}</h2>
            <p>{pickLocalized(section.blurb, lang)}</p>
          </div>
          <div className="grid">
            {section.items.map((item, j) => (
              <a key={item.slug} href={ROUTES.doc(item.slug)} className="card">
                <div className={`card-accent ${accents[(i + j) % accents.length]}`} />
                <div className="card-kicker">{section.id}</div>
                <div className="card-title">{item.title}</div>
                {item.summary ? <div className="card-body">{item.summary}</div> : null}
              </a>
            ))}
          </div>
        </div>
      ))}

      <div className="section-head">
        <h2>{t("home.artifacts.title")}</h2>
        <p>{t("home.artifacts.blurb")}</p>
      </div>
      <div className="grid">
        {artifactPages.map((a) => (
          <a key={a.slug} href={ROUTES.artifact(a.slug)} className="card">
            <div className="card-accent" />
            <div className="card-kicker">
              {a.tags.map((tag) => pickLocalized(tag, lang)).join(" · ") || "artifact"}
            </div>
            <div className="card-title">{pickLocalized(a.title, lang)}</div>
            <div className="card-body">{pickLocalized(a.description, lang)}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
