import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";

const DATA_POINT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR42mMQEhb5TwxmGFVIX4UAFJl54dzcLaAAAAAASUVORK5CYII=";
const EMAIL_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'";
const PREVIEW_HEIGHT = 520;
const EMAIL_DISPLAY_STYLE = `
html,body{overflow:hidden!important;max-width:100%!important}
*{box-sizing:border-box!important}
table{max-width:100%!important}
img{max-width:100%!important;height:auto!important}
h1,h2,h3,h4,p,li,td,th{overflow-wrap:anywhere!important}
`;

function displayHtml(html: string): string {
  const withAssets = html
    .replaceAll("cid:eta-logo@eta", "/Eta-Logo.png")
    .replaceAll("cid:eta-data@demo", DATA_POINT);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}"><style>${EMAIL_DISPLAY_STYLE}</style><base target="_blank">`;
  return /<head(?:\s[^>]*)?>/i.test(withAssets)
    ? withAssets.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${meta}`)
    : `<!doctype html><html><head>${meta}</head><body>${withAssets}</body></html>`;
}

export function EmailMessageHtml({
  html,
  text,
  title,
}: {
  html: string;
  text: string;
  title: string;
}) {
  const { t } = useTranslation("email");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(420);
  const [expanded, setExpanded] = useState(false);
  if (html.trim() === "") return <Markdown>{text}</Markdown>;
  const fit = () => {
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    setHeight(
      Math.max(
        360,
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ) + 2,
    );
  };
  const loaded = () => {
    fit();
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    for (const image of Array.from(document.images ?? [])) {
      if (!image.complete) image.addEventListener("load", fit, { once: true });
    }
  };
  const collapsed = !expanded && height > PREVIEW_HEIGHT;
  return (
    <div className="mt-2">
      <div className="relative overflow-hidden">
        <iframe
          ref={frameRef}
          title={title}
          srcDoc={displayHtml(html)}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          scrolling="no"
          className={`block w-full overflow-hidden border-0 bg-white ${collapsed ? "h-[360px] sm:h-[520px]" : ""}`}
          style={collapsed ? undefined : { height }}
          onLoad={loaded}
        />
        {collapsed ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-white to-transparent"
          />
        ) : null}
      </div>
      {height > PREVIEW_HEIGHT ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-center text-xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("thread.collapseBody") : t("thread.expandBody")}
          <CaretDownIcon
            aria-hidden="true"
            className={expanded ? "rotate-180" : ""}
          />
        </Button>
      ) : null}
    </div>
  );
}
