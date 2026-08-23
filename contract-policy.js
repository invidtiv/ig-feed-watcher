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

const READ_ONLY_DESCRIPTION =
  'This served API contract is read-only and lists GET operations only.';

function componentKeyFromRef(ref) {
  const prefix = '#/components/';
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) return null;
  const parts = ref.slice(prefix.length).split('/');
  if (parts.length !== 2) return null;
  return parts
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('/');
}

function collectComponentReferences(value, references) {
  if (Array.isArray(value)) {
    for (const item of value) collectComponentReferences(item, references);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const componentKey = componentKeyFromRef(value.$ref);
  if (componentKey) references.add(componentKey);

  if (Array.isArray(value.security)) {
    for (const requirement of value.security) {
      for (const scheme of Object.keys(requirement || {})) {
        references.add(`securitySchemes/${scheme}`);
      }
    }
  }

  for (const child of Object.values(value)) {
    collectComponentReferences(child, references);
  }
}

function pruneUnreferencedComponents(contract) {
  const references = new Set();
  for (const [key, value] of Object.entries(contract)) {
    if (key !== 'components') collectComponentReferences(value, references);
  }

  const visited = new Set();
  while (true) {
    const componentKey = [...references].find((key) => !visited.has(key));
    if (!componentKey) break;
    visited.add(componentKey);
    const separator = componentKey.indexOf('/');
    const section = componentKey.slice(0, separator);
    const name = componentKey.slice(separator + 1);
    collectComponentReferences(contract.components?.[section]?.[name], references);
  }

  for (const [section, components] of Object.entries(contract.components || {})) {
    for (const name of Object.keys(components || {})) {
      if (!references.has(`${section}/${name}`)) delete components[name];
    }
    if (Object.keys(components || {}).length === 0) delete contract.components[section];
  }
  if (contract.components && Object.keys(contract.components).length === 0) {
    delete contract.components;
  }
}

function hideMutationCapabilityMetadata(contract) {
  const retentionProperties =
    contract.components?.schemas?.RetentionSettings?.properties;
  if (retentionProperties) {
    delete retentionProperties.ok;
    delete retentionProperties.editable;
    delete retentionProperties.mutations_enabled;
  }

  const groupsTag = contract.tags?.find((tag) => tag.name === 'groups');
  if (groupsTag) groupsTag.description = 'Interest groups and their feeds.';
}

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
    contract.info.description = READ_ONLY_DESCRIPTION;
  }
  hideMutationCapabilityMetadata(contract);
  pruneUnreferencedComponents(contract);
  return contract;
}
