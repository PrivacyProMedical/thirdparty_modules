// api loader & runner to ensure the cwd is correct in case the api method relies on relative path
import fs from 'node:fs';
import url from 'node:url';
import path from 'node:path';

export function createApiLoader(apiDir, entryFile = 'index.js') {
  const apiLoader = {
    async load() {
      if (this.api) return this.api;
      const cwd = process.cwd();
      process.chdir(apiDir);
      try {
        this.api = await import(url.pathToFileURL(path.join(apiDir, entryFile)).href);
      } finally {
        process.chdir(cwd);
      }
      return this.api;
    },
    run(apiFn) {
      return function (...args) {
        const cwd = process.cwd();
        process.chdir(apiDir);
        let res;
        try {
          res = apiFn(...args);
        } catch (err) {
          process.chdir(cwd);
          throw err;
        }
        if (typeof res?.then === 'function') {
          return res.finally(() => process.chdir(cwd));
        }
        process.chdir(cwd);
        return res;
      };
    },
    api: null,
  };
  return apiLoader;
}

const STANDARD_API_TYPES = new Set([
  'PATIENT',
  'STUDY',
  'SERIES',
  'INSTANCE',
  'FOLDER',
  'FILE',
  'STRING',
  'NUMBER',
  'BOOLEAN',
]);

const EXPORT_MODULE_API_INTROSPECTION_SCRIPT = String.raw`
import inspect

def __pmt_export_module_api_introspection():
    export_api = globals().get('__export_module_api__')
    defined = {}
    for name, obj in globals().items():
        if inspect.isfunction(obj) and getattr(obj, '__module__', None) == '__main__':
            try:
                signature = inspect.signature(obj)
            except Exception:
                continue
            defined[name] = {
                'parameters': [
                    {
                        'name': parameter.name,
                        'kind': parameter.kind.name,
                        'has_default': parameter.default is not inspect._empty,
                    }
                    for parameter in signature.parameters.values()
                ]
            }
    return {
        'has_export_module_api': export_api is not None,
        'export_module_api': export_api,
        'defined_functions': defined,
    }

__pmt_export_module_api_introspection()
`;

const PYODIDE_MODULE_ENVIRONMENT_SETUP_SCRIPT = String.raw`
import sys

_module_dir = globals().get('__module_dir__')
if _module_dir and _module_dir not in sys.path:
  sys.path.insert(0, _module_dir)
`;

export class ExportModuleApiValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ExportModuleApiValidationError';
    this.code = details.code || 'EXPORT_MODULE_API_VALIDATION_ERROR';
    this.phase = details.phase || 'load';
    this.functionName = details.functionName || null;
    this.details = details;
  }
}

export function initializePyodideModuleEnvironment(pyodide, mainPy) {
  const moduleDir = path.dirname(mainPy);
  const virtualModuleDir = buildVirtualModuleDir(moduleDir);
  mirrorPyodideModuleRoot(pyodide, moduleDir, virtualModuleDir);

  pyodide.globals.set('__file__', `${virtualModuleDir}/${path.basename(mainPy)}`);
  pyodide.globals.set('__module_dir__', virtualModuleDir);
  pyodide.runPython(PYODIDE_MODULE_ENVIRONMENT_SETUP_SCRIPT);
  return {
    __file__: `${virtualModuleDir}/${path.basename(mainPy)}`,
    __module_dir__: virtualModuleDir,
  };
}

function buildVirtualModuleDir(moduleDir) {
  return `/__pmt_module_api__/${moduleDir.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
}

function mirrorPyodideModuleRoot(pyodide, moduleDir, virtualModuleDir) {
  ensurePyodideDir(pyodide, virtualModuleDir);
  for (const entry of fs.readdirSync(moduleDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const hostPath = path.join(moduleDir, entry.name);
    const virtualPath = `${virtualModuleDir}/${entry.name}`;
    pyodide.FS.writeFile(virtualPath, fs.readFileSync(hostPath));
  }
}

function ensurePyodideDir(pyodide, dirPath) {
  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      pyodide.FS.mkdir(current);
    } catch {}
  }
}

export function inspectPyodideExportModuleApi(pyodide) {
  const proxy = pyodide.runPython(EXPORT_MODULE_API_INTROSPECTION_SCRIPT);
  try {
    if (proxy && typeof proxy.toJs === 'function') {
      return proxy.toJs({ dict_converter: Object.fromEntries });
    }
    return proxy;
  } finally {
    proxy?.destroy?.();
  }
}

export function parseAndValidatePyodideExportModuleApi(pyodide, options = {}) {
  const inspection = inspectPyodideExportModuleApi(pyodide);
  return validateExportModuleApiInspection(inspection, options);
}

export function validateExportModuleApiInspection(inspection, options = {}) {
  const sourceLabel = options.sourceLabel || '__export_module_api__';
  const definedFunctions = isPlainObject(inspection?.defined_functions)
    ? inspection.defined_functions
    : {};

  if (!inspection?.has_export_module_api) {
    return {
      mode: 'free',
      sourceLabel,
      exportModuleApi: null,
      definedFunctions,
      exportedFunctions: {},
    };
  }

  const exportModuleApi = inspection?.export_module_api;
  if (!isPlainObject(exportModuleApi)) {
    throwValidationError(`${sourceLabel} must be a dict-like object.`, {
      code: 'EXPORT_API_INVALID_SHAPE',
      sourceLabel,
    });
  }

  if (exportModuleApi.version !== 1) {
    throwValidationError(`${sourceLabel}.version must equal 1.`, {
      code: 'EXPORT_API_INVALID_VERSION',
      sourceLabel,
    });
  }

  if (!isPlainObject(exportModuleApi.functions) || Object.keys(exportModuleApi.functions).length === 0) {
    throwValidationError(`${sourceLabel}.functions must be a non-empty object.`, {
      code: 'EXPORT_API_INVALID_FUNCTIONS',
      sourceLabel,
    });
  }

  const exportedFunctions = {};
  for (const [functionName, functionDecl] of Object.entries(exportModuleApi.functions)) {
    if (!functionName) {
      throwValidationError(`${sourceLabel}.functions contains an empty function name.`, {
        code: 'EXPORT_API_INVALID_FUNCTION_NAME',
        sourceLabel,
      });
    }
    if (!isPlainObject(functionDecl)) {
      throwValidationError(`Function declaration for '${functionName}' must be an object.`, {
        code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
        sourceLabel,
        functionName,
      });
    }

    const definedMeta = definedFunctions[functionName];
    if (!definedMeta) {
      throwValidationError(`Declared function '${functionName}' was not found in defined_functions.`, {
        code: 'EXPORT_API_FUNCTION_NOT_FOUND',
        sourceLabel,
        functionName,
      });
    }

    const signatureParameters = Array.isArray(definedMeta.parameters) ? definedMeta.parameters : [];
    if (signatureParameters.some(parameter => ['VAR_POSITIONAL', 'VAR_KEYWORD'].includes(parameter.kind))) {
      throwValidationError(`Function '${functionName}' cannot use *args or **kwargs in standard mode.`, {
        code: 'EXPORT_API_FUNCTION_SIGNATURE_INVALID',
        sourceLabel,
        functionName,
      });
    }

    if (!Array.isArray(functionDecl.args)) {
      throwValidationError(`Function '${functionName}' must declare args as an array.`, {
        code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
        sourceLabel,
        functionName,
      });
    }

    if (!isPlainObject(functionDecl.returns)) {
      throwValidationError(`Function '${functionName}' must declare returns as an object.`, {
        code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
        sourceLabel,
        functionName,
      });
    }

    const normalizedArgs = functionDecl.args.map((argDecl, index) => normalizeArgumentDeclaration(argDecl, {
      functionName,
      sourceLabel,
      index,
    }));

    if (signatureParameters.length !== normalizedArgs.length) {
      throwValidationError(
        `Function '${functionName}' declaration args length (${normalizedArgs.length}) does not match the Python signature (${signatureParameters.length}).`,
        {
          code: 'EXPORT_API_FUNCTION_SIGNATURE_INVALID',
          sourceLabel,
          functionName,
        },
      );
    }

    normalizedArgs.forEach((argDecl, index) => {
      const signatureParameter = signatureParameters[index];
      if (signatureParameter?.name !== argDecl.name) {
        throwValidationError(
          `Function '${functionName}' declaration arg '${argDecl.name}' does not match Python signature parameter '${signatureParameter?.name || '<missing>'}'.`,
          {
            code: 'EXPORT_API_FUNCTION_SIGNATURE_INVALID',
            sourceLabel,
            functionName,
          },
        );
      }
    });

    exportedFunctions[functionName] = {
      name: functionName,
      args: normalizedArgs,
      returns: normalizeReturnDeclaration(functionDecl.returns, {
        functionName,
        sourceLabel,
      }),
      signature: definedMeta,
    };
  }

  return {
    mode: 'standard',
    sourceLabel,
    exportModuleApi,
    definedFunctions,
    exportedFunctions,
  };
}

export function validateExportedFunctionCall(moduleApi, functionName, providedArgs = []) {
  const functionMeta = getExportedFunctionMeta(moduleApi, functionName);
  if (!Array.isArray(providedArgs)) {
    throwValidationError(`Call arguments for '${functionName}' must be an array.`, {
      code: 'EXPORT_API_ARGUMENTS_INVALID',
      phase: 'call',
      functionName,
      sourceLabel: moduleApi?.sourceLabel,
    });
  }
  if (providedArgs.length > functionMeta.args.length) {
    throwValidationError(`Function '${functionName}' received too many arguments. Expected ${functionMeta.args.length}, got ${providedArgs.length}.`, {
      code: 'EXPORT_API_ARGUMENTS_INVALID',
      phase: 'call',
      functionName,
      sourceLabel: moduleApi?.sourceLabel,
    });
  }

  const resolvedArgs = [];
  for (let index = 0; index < functionMeta.args.length; index++) {
    const argDecl = functionMeta.args[index];
    const rawValue = providedArgs[index];
    const wasProvided = index < providedArgs.length && rawValue !== undefined;

    if (!wasProvided) {
      if (Object.prototype.hasOwnProperty.call(argDecl, 'default')) {
        resolvedArgs.push(argDecl.default);
        continue;
      }
      if (!argDecl.required) {
        break;
      }
      throwValidationError(`Missing required argument '${argDecl.name}' for function '${functionName}'.`, {
        code: 'EXPORT_API_ARGUMENT_MISSING',
        phase: 'call',
        functionName,
        argumentName: argDecl.name,
        sourceLabel: moduleApi?.sourceLabel,
      });
    }

    validateTypedValue(argDecl.type, rawValue, {
      phase: 'call',
      functionName,
      argumentName: argDecl.name,
      sourceLabel: moduleApi?.sourceLabel,
      nullable: argDecl.nullable,
      direction: 'input',
    });
    resolvedArgs.push(rawValue);
  }

  return resolvedArgs;
}

export function validateExportedFunctionResult(moduleApi, functionName, result) {
  const functionMeta = getExportedFunctionMeta(moduleApi, functionName);
  const returnDecl = functionMeta.returns;

  if (returnDecl.kind === 'single') {
    validateTypedValue(returnDecl.type, result, {
      phase: 'call',
      functionName,
      sourceLabel: moduleApi?.sourceLabel,
      nullable: returnDecl.nullable,
      direction: 'output',
    });
    return result;
  }

  if (!isPlainObject(result)) {
    throwValidationError(`Function '${functionName}' must return an object with named fields.`, {
      code: 'EXPORT_API_RETURN_VALUE_INVALID',
      phase: 'call',
      functionName,
      sourceLabel: moduleApi?.sourceLabel,
    });
  }

  returnDecl.fields.forEach((fieldDecl) => {
    if (!(fieldDecl.name in result)) {
      throwValidationError(`Function '${functionName}' return is missing field '${fieldDecl.name}'.`, {
        code: 'EXPORT_API_RETURN_VALUE_INVALID',
        phase: 'call',
        functionName,
        sourceLabel: moduleApi?.sourceLabel,
      });
    }
    validateTypedValue(fieldDecl.type, result[fieldDecl.name], {
      phase: 'call',
      functionName,
      sourceLabel: moduleApi?.sourceLabel,
      nullable: fieldDecl.nullable,
      direction: 'output',
    });
  });

  return result;
}

export function createExportModuleApiDebugSnapshot(moduleApi, overrides = {}) {
  return {
    mode: moduleApi?.mode || 'free',
    sourceLabel: overrides.sourceLabel || moduleApi?.sourceLabel || '__export_module_api__',
    exportModuleApi: moduleApi?.exportModuleApi || null,
    definedFunctions: moduleApi?.definedFunctions || {},
    exportedFunctions: moduleApi?.exportedFunctions || {},
  };
}

export function createExportModuleApiDebugHandler(getModuleApi) {
  return async function __debug_export_module_api__() {
    const moduleApi = await getModuleApi();
    return createExportModuleApiDebugSnapshot(moduleApi);
  };
}

export function createPyodideModuleRuntime({
  moduleDir,
  loadPyodide,
  sourceLabel,
  cExtensionPackages = [],
  wheelPackages = [],
}) {
  let mainPy = '';
  let py = '';
  let pyodide = null;
  let exportModuleApi = null;

  async function init(ctx) {
    if (pyodide || py || mainPy) {
      return pyodide;
    }

    if (ctx?.__file__) {
      mainPy = path.join(path.dirname(ctx.__file__), 'api', 'main.py');
    } else {
      mainPy = path.join(moduleDir, 'api', 'main.py');
    }

    if (mainPy && fs.existsSync(mainPy)) {
      py = fs.readFileSync(mainPy, 'utf-8');
    }

    if (!py) {
      return pyodide;
    }

    const packageCacheDir = path.join(path.dirname(mainPy), 'requirements');
    if (!fs.existsSync(packageCacheDir)) {
      fs.mkdirSync(packageCacheDir, { recursive: true });
    }

    pyodide = await loadPyodide({ packageCacheDir });
    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');

    for (const pkg of cExtensionPackages) {
      await micropip.install(pkg);
    }

    for (const pkg of wheelPackages) {
      let whl = fs.readdirSync(packageCacheDir).find(
        file => (file.startsWith(`${pkg}-`) || file.startsWith(`${pkg}_`)) && file.endsWith('.whl')
      );
      if (whl) {
        whl = path.join(packageCacheDir, whl);
      }
      if (whl && fs.existsSync(whl)) {
        const tmp = `/tmp/${path.basename(whl)}`;
        pyodide.FS.writeFile(tmp, fs.readFileSync(whl));
        await micropip.install(`emfs://${tmp}`);
        pyodide.FS.unlink(tmp);
      } else {
        await micropip.install(pkg);
      }
    }

    initializePyodideModuleEnvironment(pyodide, mainPy);
    await pyodide.runPythonAsync(py);
    micropip.destroy();

    exportModuleApi = parseAndValidatePyodideExportModuleApi(pyodide, {
      sourceLabel,
    });

    return pyodide;
  }

  function getPyodide() {
    return pyodide;
  }

  function getExportModuleApi() {
    return exportModuleApi;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function bridgeHostFileToVFS(hostPath, virtualPath) {
    pyodide.FS.writeFile(virtualPath, fs.readFileSync(hostPath));
    return virtualPath;
  }

  function bridgeFileFromVFS(virtualPath, hostPath) {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, pyodide.FS.readFile(virtualPath));
    return hostPath;
  }

  function stageSeriesPayload(payload, label) {
    const cloned = cloneJson(payload);
    const seen = new Map();
    let counter = 0;

    function rewrite(node) {
      if (!node || typeof node !== 'object') {
        return;
      }
      Object.entries(node).forEach(([key, value]) => {
        if (key === 'filePath' && typeof value === 'string') {
          let virtualPath = seen.get(value);
          if (!virtualPath) {
            virtualPath = `/tmp/${label}_${counter++}_${path.basename(value)}`;
            bridgeHostFileToVFS(value, virtualPath);
            seen.set(value, virtualPath);
          }
          node[key] = virtualPath;
          return;
        }
        if (value && typeof value === 'object') {
          rewrite(value);
        }
      });
    }

    rewrite(cloned);
    return cloned;
  }

  function stageFilePayload(payload, label) {
    const cloned = cloneJson(payload);
    const selection = cloned?.selection;
    const hostPath = selection?.path || selection?.filePath;
    if (!hostPath) {
      throw new Error(`${label} must provide selection.path or selection.filePath.`);
    }
    const key = selection.path ? 'path' : 'filePath';
    const virtualPath = `/tmp/${label}_${Date.now()}_${path.basename(hostPath)}`;
    bridgeHostFileToVFS(hostPath, virtualPath);
    selection[key] = virtualPath;
    return cloned;
  }

  function stageFilePayloadToVirtualPath(filePayload, label) {
    const selection = filePayload?.selection;
    const hostPath = selection?.path || selection?.filePath;
    if (!hostPath) {
      throw new Error(`${label} must provide selection.path or selection.filePath.`);
    }
    const virtualPath = `/tmp/${label}_${Date.now()}_${path.basename(hostPath)}`;
    bridgeHostFileToVFS(hostPath, virtualPath);
    return virtualPath;
  }

  function bridgeOutputFilePayloadToHost(filePayload, hostOutputDir) {
    const selection = filePayload?.selection;
    const virtualPath = selection?.path;
    if (!(virtualPath && typeof virtualPath === 'string')) {
      return filePayload;
    }
    const outputName = selection?.name || path.basename(virtualPath);
    const hostPath = path.join(hostOutputDir, outputName);
    bridgeFileFromVFS(virtualPath, hostPath);
    return {
      ...filePayload,
      selection: {
        ...selection,
        path: hostPath,
      },
    };
  }

  function extOf(p) {
    const match = p.match(/(\.[^.]+)$/);
    return match ? match[1] : '';
  }

  function validateCall(functionName, providedArgs = []) {
    return validateExportedFunctionCall(exportModuleApi, functionName, providedArgs);
  }

  function validateResult(functionName, result) {
    return validateExportedFunctionResult(exportModuleApi, functionName, result);
  }

  async function invokePythonFunction(functionName, args = []) {
    const handler = pyodide.globals.get(functionName);
    const pyArgs = args.map(arg => arg == null ? null : pyodide.toPy(arg));
    const resultPy = handler(...pyArgs);
    const result = resultPy?.toJs ? resultPy.toJs({ dict_converter: Object.fromEntries }) : resultPy;

    handler.destroy?.();
    pyArgs.forEach(arg => arg?.destroy?.());
    resultPy.destroy?.();

    return result;
  }

  return {
    init,
    getPyodide,
    getExportModuleApi,
    cloneJson,
    bridgeHostFileToVFS,
    bridgeFileFromVFS,
    stageSeriesPayload,
    stageFilePayload,
    stageFilePayloadToVirtualPath,
    bridgeOutputFilePayloadToHost,
    extOf,
    validateCall,
    validateResult,
    invokePythonFunction,
    createDebugHandler() {
      return createExportModuleApiDebugHandler(async () => {
        await init();
        return exportModuleApi;
      });
    },
  };
}

function normalizeArgumentDeclaration(argDecl, context) {
  if (!isPlainObject(argDecl)) {
    throwValidationError(`Argument declaration #${context.index + 1} for '${context.functionName}' must be an object.`, {
      code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
      sourceLabel: context.sourceLabel,
      functionName: context.functionName,
    });
  }
  if (typeof argDecl.name !== 'string' || !argDecl.name) {
    throwValidationError(`Argument declaration #${context.index + 1} for '${context.functionName}' must define a non-empty name.`, {
      code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
      sourceLabel: context.sourceLabel,
      functionName: context.functionName,
    });
  }
  if (!STANDARD_API_TYPES.has(argDecl.type)) {
    throwValidationError(`Argument '${argDecl.name}' for '${context.functionName}' must use a supported type.`, {
      code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
      sourceLabel: context.sourceLabel,
      functionName: context.functionName,
    });
  }

  const required = Object.prototype.hasOwnProperty.call(argDecl, 'required') ? Boolean(argDecl.required) : true;
  const nullable = Object.prototype.hasOwnProperty.call(argDecl, 'nullable') ? Boolean(argDecl.nullable) : false;
  if (required && Object.prototype.hasOwnProperty.call(argDecl, 'default')) {
    throwValidationError(`Argument '${argDecl.name}' for '${context.functionName}' cannot define default while required is true.`, {
      code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
      sourceLabel: context.sourceLabel,
      functionName: context.functionName,
    });
  }

  if (Object.prototype.hasOwnProperty.call(argDecl, 'default')) {
    validateTypedValue(argDecl.type, argDecl.default, {
      phase: 'load',
      functionName: context.functionName,
      argumentName: argDecl.name,
      sourceLabel: context.sourceLabel,
      nullable: nullable,
      direction: 'input',
      code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
    });
  }

  return {
    name: argDecl.name,
    type: argDecl.type,
    required,
    nullable,
    ...(Object.prototype.hasOwnProperty.call(argDecl, 'default') ? { default: argDecl.default } : {}),
  };
}

function normalizeReturnDeclaration(returnDecl, context) {
  if (STANDARD_API_TYPES.has(returnDecl.type)) {
    return {
      kind: 'single',
      type: returnDecl.type,
      nullable: Object.prototype.hasOwnProperty.call(returnDecl, 'nullable') ? Boolean(returnDecl.nullable) : false,
    };
  }

  if (!Array.isArray(returnDecl.fields) || returnDecl.fields.length === 0) {
    throwValidationError(`Function '${context.functionName}' must declare returns as either { type } or non-empty { fields }.`, {
      code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
      sourceLabel: context.sourceLabel,
      functionName: context.functionName,
    });
  }

  const fields = returnDecl.fields.map((fieldDecl, index) => {
    if (!isPlainObject(fieldDecl) || typeof fieldDecl.name !== 'string' || !fieldDecl.name) {
      throwValidationError(`Return field #${index + 1} for '${context.functionName}' must define a non-empty name.`, {
        code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
        sourceLabel: context.sourceLabel,
        functionName: context.functionName,
      });
    }
    if (!STANDARD_API_TYPES.has(fieldDecl.type)) {
      throwValidationError(`Return field '${fieldDecl.name}' for '${context.functionName}' must use a supported type.`, {
        code: 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
        sourceLabel: context.sourceLabel,
        functionName: context.functionName,
      });
    }
    return {
      name: fieldDecl.name,
      type: fieldDecl.type,
      nullable: Object.prototype.hasOwnProperty.call(fieldDecl, 'nullable') ? Boolean(fieldDecl.nullable) : false,
    };
  });

  return {
    kind: 'fields',
    fields,
  };
}

function getExportedFunctionMeta(moduleApi, functionName) {
  if (moduleApi?.mode !== 'standard') {
    throwValidationError(`Module API is not in standard mode; cannot access exported function '${functionName}'.`, {
      code: 'EXPORT_API_MODE_INVALID',
      functionName,
      sourceLabel: moduleApi?.sourceLabel,
    });
  }
  const functionMeta = moduleApi.exportedFunctions?.[functionName];
  if (!functionMeta) {
    throwValidationError(`Function '${functionName}' is not declared in exported_functions.`, {
      code: 'EXPORT_API_FUNCTION_NOT_EXPORTED',
      functionName,
      sourceLabel: moduleApi?.sourceLabel,
    });
  }
  return functionMeta;
}

function validateTypedValue(type, value, context) {
  if (value == null) {
    if (context.nullable) {
      return;
    }
    throwValidationError(buildTypeErrorMessage(type, value, context), {
      code: context.code || buildRuntimeTypeErrorCode(context.direction),
      phase: context.phase || 'call',
      functionName: context.functionName,
      argumentName: context.argumentName,
      sourceLabel: context.sourceLabel,
      expectedType: type,
      actualType: describeRuntimeType(value),
    });
  }

  switch (type) {
    case 'STRING':
      return ensure(typeof value === 'string', type, value, context);
    case 'NUMBER':
      return ensure(typeof value === 'number' && Number.isFinite(value), type, value, context);
    case 'BOOLEAN':
      return ensure(typeof value === 'boolean', type, value, context);
    case 'PATIENT':
      return validatePatientPayload(value, context);
    case 'STUDY':
      return validateStudyPayload(value, context);
    case 'SERIES':
      return validateSeriesPayload(value, context);
    case 'INSTANCE':
      return validateInstancePayload(value, context);
    case 'FOLDER':
      return validateFolderPayload(value, context);
    case 'FILE':
      return validateFilePayload(value, context);
    default:
      throwValidationError(`Unsupported standard API type '${type}'.`, {
        code: context.code || 'EXPORT_API_FUNCTION_SCHEMA_INVALID',
        phase: context.phase || 'load',
        functionName: context.functionName,
        sourceLabel: context.sourceLabel,
      });
  }
}

function validatePatientPayload(value, context) {
  validatePatientFamilyPayload(value, 'patient', 1, 1, context);
}

function validateStudyPayload(value, context) {
  validatePatientFamilyPayload(value, 'study', 2, 2, context);
}

function validateSeriesPayload(value, context) {
  validatePatientFamilyPayload(value, 'series', 3, 3, context);
}

function validateInstancePayload(value, context) {
  validatePatientFamilyPayload(value, 'instance', 4, 4, context);
  ensure(typeof value.selection.fileName === 'string', 'INSTANCE', value, context);
  ensure(typeof value.selection.filePath === 'string', 'INSTANCE', value, context);
}

function validatePatientFamilyPayload(value, slot, minKeys, level, context) {
  ensure(isPlainObject(value), slot.toUpperCase(), value, context);
  ensure(value.from === 'patient', slot.toUpperCase(), value, context);
  ensure(typeof value.root === 'string', slot.toUpperCase(), value, context);
  ensure(Array.isArray(value.keys) && value.keys.length >= minKeys, slot.toUpperCase(), value, context);
  ensure(isPlainObject(value.selection), slot.toUpperCase(), value, context);
  ensure(value.selection.slot === slot, slot.toUpperCase(), value, context);
  ensure(value.selection.level === level, slot.toUpperCase(), value, context);
  ensure(typeof value.selection.name === 'string', slot.toUpperCase(), value, context);
}

function validateFilePayload(value, context) {
  ensure(isPlainObject(value), 'FILE', value, context);
  const allowedFrom = context.direction === 'output' ? ['module'] : ['root', 'module'];
  ensure(allowedFrom.includes(value.from), 'FILE', value, context);
  ensure(isPlainObject(value.selection), 'FILE', value, context);
  ensure(value.selection.isFile === true, 'FILE', value, context);
  ensure(typeof value.selection.name === 'string', 'FILE', value, context);
  ensure(typeof value.selection.path === 'string', 'FILE', value, context);
}

function validateFolderPayload(value, context) {
  ensure(isPlainObject(value), 'FOLDER', value, context);
  const allowedFrom = context.direction === 'output' ? ['module'] : ['root', 'module'];
  ensure(allowedFrom.includes(value.from), 'FOLDER', value, context);
  ensure(isPlainObject(value.selection), 'FOLDER', value, context);
  ensure(value.selection.isDirectory === true, 'FOLDER', value, context);
  ensure(typeof value.selection.name === 'string', 'FOLDER', value, context);
  ensure(typeof value.selection.path === 'string', 'FOLDER', value, context);
  if (context.direction === 'output') {
    ensure(Array.isArray(value.selection.children), 'FOLDER', value, context);
  } else if (value.selection.children !== undefined) {
    ensure(Array.isArray(value.selection.children), 'FOLDER', value, context);
  }
}

function ensure(condition, expectedType, value, context) {
  if (condition) {
    return;
  }
  throwValidationError(buildTypeErrorMessage(expectedType, value, context), {
    code: context.code || buildRuntimeTypeErrorCode(context.direction),
    phase: context.phase || 'call',
    functionName: context.functionName,
    argumentName: context.argumentName,
    sourceLabel: context.sourceLabel,
    expectedType,
    actualType: describeRuntimeType(value),
  });
}

function buildTypeErrorMessage(expectedType, value, context) {
  const actualType = describeRuntimeType(value);
  if (context.argumentName) {
    return `Argument '${context.argumentName}' for function '${context.functionName}' must be ${expectedType}, got ${actualType}.`;
  }
  return `Function '${context.functionName}' must use ${expectedType}, got ${actualType}.`;
}

function buildRuntimeTypeErrorCode(direction) {
  return direction === 'output'
    ? 'EXPORT_API_RETURN_VALUE_INVALID'
    : 'EXPORT_API_ARGUMENT_TYPE_INVALID';
}

function describeRuntimeType(value) {
  if (value === null) return 'NULL';
  if (value === undefined) return 'UNDEFINED';
  if (Array.isArray(value)) return 'ARRAY';
  if (typeof value === 'object') {
    if (typeof value?.from === 'string') {
      return `PAYLOAD(${value.from})`;
    }
    return 'OBJECT';
  }
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : 'NUMBER';
  return typeof value === 'string' ? 'STRING' : typeof value === 'boolean' ? 'BOOLEAN' : typeof value;
}

function throwValidationError(message, details = {}) {
  throw new ExportModuleApiValidationError(message, details);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
