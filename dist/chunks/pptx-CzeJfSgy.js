import{r as e}from"./base64-BhqO9xnt.js";import{t}from"./markdown-B9Szs29K.js";import{i as n,r}from"./text-CZ1iVbTh.js";function i(e){switch(e.type){case`text`:case`shape`:return e.content?r(e.content):``;case`table`:{let n=Array.isArray(e.data)?e.data:[];return t(n.map(e=>e.map(e=>r(e?.text??``))))}case`math`:return e.text?r(e.text):e.latex?`$`+e.latex+`$`:``;case`diagram`:{let t=(e.textList??[]).map(e=>e.trim()).filter(Boolean);return t.length?t.map(e=>`- `+e).join(`
`):a(e.elements??[])}case`group`:return a(e.elements??[]);default:return``}}function a(e){return[...e].sort((e,t)=>{let n=(e.top??0)-(t.top??0);return Math.abs(n)>8?n:(e.left??0)-(t.left??0)}).map(i).map(e=>e.trim()).filter(Boolean).join(`

`)}async function o(t){let i=await import(`./pptxtojson-BAes2-8-.js`),o=i.parse??i.default?.parse;if(!o)throw Error(`pptxtojson failed to load`);let s=await o(e(t),{imageMode:`none`,videoMode:`none`,audioMode:`none`}),c=[];return s.slides.forEach((e,t)=>{let i=a(e.elements),o=e.note?n(r(e.note)):``,s=`## Slide ${t+1}`;i&&(s+=`

`+i),o&&(s+=`

> Notes: `+o.replace(/\n/g,`
> `)),c.push(s)}),c.join(`

`)}export{o as parsePptx};