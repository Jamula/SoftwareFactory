const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const token = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);
const dense = a => Array.isArray(a) && Object.keys(a).length === a.length &&
  Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
const blocked = reason => ({state:'blocked',reason});
export function routeContract(catalog, request) {
  if (!request || !token(request.component) || !sha(request.revision) ||
      !dense(catalog) || !catalog.every(c=>c && token(c.component) && token(c.owner) &&
        token(c.specialty) && sha(c.revision))) return blocked('INVALID_CONTRACT');
  const matches=catalog.filter(c=>c.component===request.component);
  if (matches.length!==1) return blocked('OWNERSHIP_UNKNOWN');
  const c=matches[0];
  if(c.revision!==request.revision) return blocked('STALE_CONTRACT');
  if(!dense(request.allowedSpecialties) || !request.allowedSpecialties.every(token) ||
     !request.allowedSpecialties.includes(c.specialty)) return blocked('SPECIALTY_UNAVAILABLE');
  return {state:'shadow-routed',owner:c.owner,specialty:c.specialty,revision:c.revision};
}
