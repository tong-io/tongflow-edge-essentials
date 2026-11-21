const e=500,t=50,n=8e3,r=/* @__PURE__ */ new Set([`。`,`！`,`？`,`；`,`!`,`?`,`;`,`…`,`．`]),i=/* @__PURE__ */ new Set([`”`,`’`,`"`,`'`,`」`,`』`,`）`,`)`,`】`,`]`,`》`,`〉`]),a=/* @__PURE__ */ new Set([`，`,`、`,`：`,`,`,`:`,` `,`	`,`
`,`　`]),o=e=>/^\s*\|/.test(e),s=e=>/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(e),c=e=>/^\s*(```|~~~)/.test(e),l=e=>/^#{1,6}\s/.test(e);function u(e){return e.map(e=>typeof e==`string`?e.replace(/\r\n?/g,`
`).replace(/[ \t]+$/gm,``).trim():``).filter(Boolean).join(`

`)}function d(e){let t=[],n=e.split(`
`),r=[],i=()=>{r.length&&t.push({kind:`para`,text:r.join(`
`)}),r=[]};for(let e=0;e<n.length;e++){let a=n[e];if(c(a)){i();let r=a.trim().slice(0,3),o=[a];for(;++e<n.length&&(o.push(n[e]),!n[e].trim().startsWith(r)););t.push({kind:`code`,text:o.join(`
`)})}else if(o(a)){i();let r=[a];for(;e+1<n.length&&o(n[e+1]);)r.push(n[++e]);t.push({kind:`table`,text:r.join(`
`)})}else l(a)?(i(),t.push({kind:`heading`,text:a.trim()})):a.trim()?r.push(a):i()}return i(),t}function f(e){let t=[],n=0,a=0,o=e.length;for(;a<o;){let s=e[a],c=-1;if(r.has(s)){let t=a+1;for(;t<o&&(r.has(e[t])||i.has(e[t]));)t++;c=t}else(s===`.`&&(a+1>=o||/\s/.test(e[a+1]))||s===`
`)&&(c=a+1);if(c>0){for(;c<o&&/\s/.test(e[c]);)c++;t.push(e.slice(n,c)),n=a=c}else a++}return n<o&&t.push(e.slice(n)),t.filter(e=>e.trim())}function p(e,t){if(t<=0||t>=e.length)return t;let n=e.charCodeAt(t);return n>=56320&&n<=57343?t-1:t}function m(e,t){let n=[],r=e;for(;r.length>t;){let e=-1;for(let n=t;n>=Math.floor(t*.7);n--)if(a.has(r[n-1])){e=n;break}e<0&&(e=t),e=p(r,e),e<=0&&(e=t),n.push(r.slice(0,e)),r=r.slice(e)}return r&&n.push(r),n}function h(e,t){let n=e.split(`
`),r=n.length>1&&s(n[1])?n.slice(0,2).join(`
`):``,i=r?n.slice(2):n,a=[],o=r&&r.length+1<t/2?r+`
`:``,c=``;for(let e of i){if(o.length+e.length>t){c&&a.push(o+c),c=``,a.push(...m(e,t));continue}let n=c?`${c}\n${e}`:e;o.length+n.length>t?(a.push(o+c),c=e):c=n}return c&&a.push(o+c),a}function g(e,t){let n=[];for(let r of e){if(r.text.length<=t){n.push({kind:r.kind,text:r.text,joiner:`

`});continue}if(r.kind===`table`){h(r.text,t).forEach(e=>n.push({kind:`table`,text:e,joiner:`

`}));continue}if(r.kind===`code`){let e=r.text.split(`
`).flatMap(e=>m(e,t-1)),i=``;for(let r of e)i&&i.length+1+r.length>t?(n.push({kind:`code`,text:i,joiner:`

`}),i=r):i=i?`${i}\n${r}`:r;i&&n.push({kind:`code`,text:i,joiner:`

`});continue}let e=!0;for(let i of f(r.text))for(let r of i.length>t?m(i,t):[i])n.push({kind:`para`,text:r,joiner:e?`

`:``}),e=!1}return n}function _(e,t){if(t<=0)return``;let n=e.trimEnd();if(!n)return``;let i=f(n),o=``;for(let e=i.length-1;e>=0;e--){let n=i[e]+o;if(n.trim().length>t)break;o=n}if(o.trim())return o.trimStart();let s=p(n,n.length-t);for(let e=s;e<n.length-Math.floor(t/2);e++)if(a.has(n[e])||r.has(n[e])){s=e+1;break}return n.slice(s).trimStart()}function v(e,t={}){let r=Math.min(n,Math.max(50,Math.floor(t.maxChars??500))),i=Math.max(0,Math.min(Math.floor(t.overlap??Math.min(80,r/5)),Math.floor(r/2))),a=u(typeof e==`string`?[e]:e);if(!a)return[];let o=g(d(a),r),s=[],c=[],l=0,f=e=>c.length?l+e.joiner.length+e.text.length:e.text.length,p=e=>{l=f(e),c.push(e)},m=e=>e.map((e,t)=>t?e.joiner+e.text:e.text).join(``);for(let e of o){if(f(e)<=r){p(e);continue}let t=[];for(;c.length>1&&c[c.length-1].kind===`heading`;)t.unshift(c.pop());let n=c,a=m(n);a.trim()&&s.push(a.trim()),c=[],l=0;for(let e of t)p(e);c.length&&f(e)>r&&(s.push(m(c).trim()),c=[],l=0);let o=n[n.length-1];if(!c.length&&i>0&&e.kind===`para`&&o?.kind===`para`){let t=_(a,Math.min(i,r-e.text.length-e.joiner.length-1));t&&!e.joiner&&/[\x21-\x7e]$/.test(t)&&/^[\x21-\x7e]/.test(e.text)&&(t+=` `),t&&p({kind:`para`,text:t,joiner:``})}p(e)}let h=m(c).trim();return h&&s.push(h),s.filter(e=>e.trim().length>0)}export{e as DEFAULT_MAX_CHARS,n as MAX_MAX_CHARS,t as MIN_MAX_CHARS,v as chunkText};