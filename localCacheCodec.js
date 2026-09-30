// Lossless dictionary encoding for large local caches. Cloud and JSON exports
// continue to use ordinary objects. Old plain-JSON caches remain readable.
export function encodeCache(value) {
  const strings=[], ids=new Map(), shapes=[], shapeIds=new Map();
  const id=s=>{if(!ids.has(s)){ids.set(s,strings.length);strings.push(s)}return ids.get(s)};
  const encode=v=>{
    if(typeof v==='string')return [2,id(v)];
    if(Array.isArray(v))return [0,...v.map(x=>encode(x===undefined?null:x))];
    if(v && typeof v==='object'){
      const keys=Object.keys(v).filter(k=>v[k]!==undefined), shape=JSON.stringify(keys);
      if(!shapeIds.has(shape)){shapeIds.set(shape,shapes.length);shapes.push(keys);}
      return [1,shapeIds.get(shape),...keys.map(k=>encode(v[k]))];
    }
    return v;
  };
  const root=encode(value);
  return JSON.stringify({__omsCodec:1,strings,shapes,root});
}
export function decodeCache(raw) {
  const data=JSON.parse(raw);
  if(data.__omsCodec!==1)return data;
  const decode=v=>{
    if(!Array.isArray(v))return v;
    if(v[0]===2)return data.strings[v[1]];
    if(v[0]===0)return v.slice(1).map(decode);
    if(v[0]===1){const obj={};data.shapes[v[1]].forEach((key,i)=>Object.defineProperty(obj,key,{value:decode(v[i+2]),writable:true,enumerable:true,configurable:true}));return obj;}
    throw new Error('Invalid local cache');
  };
  return decode(data.root);
}
