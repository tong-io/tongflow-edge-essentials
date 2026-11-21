import { toArrayBuffer } from "../util/base64.js";
import { tidyText } from "../util/text.js";
import { htmlToMarkdown } from "./html.js";

interface MailParts {
    subject?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    date?: string;
    text?: string;
    html?: string;
    attachments: { name: string; mime?: string; size?: number }[];
}

function person(name?: string, address?: string): string {
    if (name && address && name !== address) return `${name} <${address}>`;
    return address || name || "";
}

function size(n?: number): string {
    if (n === undefined) return "";
    return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function render(m: MailParts): Promise<string> {
    const blocks: string[] = [];
    blocks.push("# " + (m.subject?.trim() || "(no subject)"));
    const meta: string[] = [];
    if (m.from) meta.push("- From: " + m.from);
    if (m.to?.length) meta.push("- To: " + m.to.join(", "));
    if (m.cc?.length) meta.push("- Cc: " + m.cc.join(", "));
    if (m.date) meta.push("- Date: " + m.date);
    if (meta.length) blocks.push(meta.join("\n"));
    let body = m.text ? tidyText(m.text) : "";
    if (!body && m.html) body = (await htmlToMarkdown(m.html, "document")).markdown;
    if (body) blocks.push(body);
    if (m.attachments.length) {
        const list = m.attachments.map((a) => {
            const info = [a.mime, size(a.size)].filter(Boolean).join(", ");
            return "- " + a.name + (info ? ` (${info})` : "");
        });
        blocks.push("## Attachments\n\n" + list.join("\n"));
    }
    return blocks.join("\n\n");
}

type Addr = { name?: string; address?: string; group?: { name?: string; address?: string }[] };

/** .eml / .mht (postal-mime): headers, body (plain text preferred), attachment list. */
export async function parseEml(bytes: Uint8Array): Promise<string> {
    const { default: PostalMime } = await import("postal-mime");
    const mail = await PostalMime.parse(bytes);
    const addrs = (list?: Addr[]) =>
        (list ?? [])
            .flatMap((a) => (a.group ? a.group.map((g) => person(g.name, g.address)) : [person(a.name, a.address)]))
            .filter(Boolean);
    return render({
        subject: mail.subject,
        from: mail.from ? person(mail.from.name, (mail.from as Addr).address) : undefined,
        to: addrs(mail.to as Addr[] | undefined),
        cc: addrs(mail.cc as Addr[] | undefined),
        date: mail.date,
        text: mail.text,
        html: mail.html,
        attachments: mail.attachments
            .filter((a) => a.disposition !== "inline" || a.filename)
            .map((a) => ({
                name: a.filename || "(unnamed)",
                mime: a.mimeType,
                size: typeof a.content === "string" ? a.content.length : (a.content as ArrayBuffer).byteLength,
            })),
    });
}

interface MsgData {
    error?: string;
    subject?: string;
    senderName?: string;
    senderEmail?: string;
    senderSmtpAddress?: string;
    clientSubmitTime?: string;
    messageDeliveryTime?: string;
    creationTime?: string;
    body?: string;
    bodyHtml?: string;
    html?: Uint8Array;
    recipients?: { name?: string; email?: string; smtpAddress?: string; recipType?: string }[];
    attachments?: { fileName?: string; fileNameShort?: string; name?: string; contentLength?: number; attachMimeTag?: string }[];
}

/** Outlook .msg (msgreader): same shape as .eml. */
export async function parseMsg(bytes: Uint8Array): Promise<string> {
    const mod = (await import("@kenjiuno/msgreader")) as unknown as { default: unknown };
    let Ctor = mod.default as { default?: unknown };
    if (typeof Ctor !== "function" && Ctor?.default) Ctor = Ctor.default as { default?: unknown };
    const reader = new (Ctor as unknown as new (b: ArrayBuffer) => { getFileData(): MsgData })(toArrayBuffer(bytes));
    const d = reader.getFileData();
    if (d.error) throw new Error(`not a readable Outlook .msg file (${d.error})`);
    const rec = d.recipients ?? [];
    const pick = (t: string) =>
        rec.filter((r) => (r.recipType ?? "to") === t).map((r) => person(r.name, r.smtpAddress || r.email));
    let html: string | undefined;
    if (typeof d.bodyHtml === "string") html = d.bodyHtml;
    else if (d.html instanceof Uint8Array) html = new TextDecoder("utf-8").decode(d.html);
    return render({
        subject: d.subject,
        from: person(d.senderName, d.senderSmtpAddress || d.senderEmail),
        to: pick("to"),
        cc: pick("cc"),
        date: d.clientSubmitTime || d.messageDeliveryTime || d.creationTime,
        text: d.body,
        html,
        attachments: (d.attachments ?? []).map((a) => ({
            name: a.fileName || a.fileNameShort || a.name || "(unnamed)",
            mime: a.attachMimeTag,
            size: a.contentLength,
        })),
    });
}
