/**
 * Stand-in for `unpdf/pdfjs` (unpdf's 1.7 MB serverless pdf.js build). The pdf2md alternative
 * always hands unpdf the plugin's own pdf.js (`definePDFJSModule`), so unpdf never imports this;
 * the alias in tsdown.config.ts keeps the second pdf.js out of `dist/`.
 */
throw new Error("unpdf's bundled pdf.js is not shipped: call definePDFJSModule with the plugin's pdf.js first");
