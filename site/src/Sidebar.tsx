import { artifactPages } from "./artifacts";
import { docCatalog } from "./docs";
import { pickLocalized, toggleLang, useLang, useT } from "./i18n";
import { ROUTES, type Route } from "./routes";

export function Sidebar({ route }: { route: Route }) {
  const t = useT();
  const lang = useLang();
  const activeKind = route.kind;
  const activeSlug =
    activeKind === "doc" ? route.slug : activeKind === "artifact" ? route.slug : null;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">Y</div>
        <div>
          <div className="brand-name">Yiku</div>
          <div className="brand-sub">Docs &amp; Artifacts</div>
        </div>
        <button
          type="button"
          className="lang-toggle"
          onClick={toggleLang}
          title={t("lang.toggleTitle")}
        >
          {t("lang.toggle")}
        </button>
      </div>

      <nav className="nav-group">
        <div className="nav-label">{t("nav.navigate")}</div>
        <a href={ROUTES.home} className={`nav-item ${activeKind === "home" ? "active" : ""}`}>
          <span>{t("nav.home")}</span>
        </a>
        <a href={ROUTES.gallery} className={`nav-item ${activeKind === "gallery" ? "active" : ""}`}>
          <span>{t("nav.gallery")}</span>
        </a>
      </nav>

      {docCatalog.sections.map((section) => (
        <div className="nav-group" key={section.id}>
          <div className="nav-label">{pickLocalized(section.title, lang)}</div>
          {section.items.map((item) => (
            <a
              key={item.slug}
              href={ROUTES.doc(item.slug)}
              className={`nav-item ${
                activeKind === "doc" && activeSlug === item.slug ? "active" : ""
              }`}
              title={item.title}
            >
              <span>{item.title}</span>
            </a>
          ))}
        </div>
      ))}

      <div className="nav-group">
        <div className="nav-label">{t("nav.artifacts")}</div>
        {artifactPages.map((a) => (
          <a
            key={a.slug}
            href={ROUTES.artifact(a.slug)}
            className={`nav-item ${
              activeKind === "artifact" && activeSlug === a.slug ? "active" : ""
            }`}
          >
            <span>{pickLocalized(a.title, lang)}</span>
          </a>
        ))}
      </div>

      <div className="sidebar-foot">
        {t("sidebar.foot.pre")}
        <code>site/dist</code>
        {t("sidebar.foot.post")}
      </div>
    </aside>
  );
}
