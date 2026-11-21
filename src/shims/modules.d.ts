declare module "pdfjs-dist/build/pdf.worker.mjs" {
    export const WorkerMessageHandler: unknown;
}
declare module "xlsx/dist/cpexcel.full.mjs" {
    const cptable: unknown;
    export = cptable;
}
declare module "eld/medium" {
    export const eld: { detect(text: string): { language: string; isReliable(): boolean } };
}
declare module "defuddle/dist/markdown.js" {
    export function createMarkdownContent(html: string, url: string): string;
}
