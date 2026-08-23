const OPENAPI_OPERATION_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

export function contractForCapabilities(sourceContract, { fullAgent }) {
  const contract = structuredClone(sourceContract);
  contract['x-api-mode'] = fullAgent ? 'full-agent' : 'read-only';
  if (fullAgent) return contract;

  for (const [path, pathItem] of Object.entries(contract.paths || {})) {
    for (const key of Object.keys(pathItem || {})) {
      if (OPENAPI_OPERATION_METHODS.has(key.toLowerCase()) && key.toLowerCase() !== 'get') {
        delete pathItem[key];
      }
    }
    if (!pathItem?.get) delete contract.paths[path];
  }

  if (contract.info) {
    const note = 'This served view is read-only and intentionally lists GET operations only.';
    contract.info.description = contract.info.description
      ? `${contract.info.description} ${note}`
      : note;
  }
  return contract;
}
