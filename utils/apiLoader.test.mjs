import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ModuleSchemaValidationError,
  validateModuleSchema,
  validateExportedFunctionCall,
  validateExportedFunctionResult,
} from './apiLoader.js';

// These are pure unit tests for the shared validation helpers.
// They intentionally use synthetic declarations and source labels so they do
// not depend on optional installed modules being present on disk.

function buildInstancePayload() {
  return {
    from: 'patient',
    root: '/data',
    keys: ['Patient A', 'Study 1', 'Series 2', 'Instance 3'],
    selection: {
      slot: 'instance',
      level: 4,
      name: 'image.dcm',
      fileName: 'image.dcm',
      filePath: '/data/image.dcm',
    },
  };
}

function buildModuleFilePayload(name, path) {
  return {
    from: 'module',
    selection: {
      name,
      path,
      isFile: true,
    },
  };
}

function buildSchema(functionName, args, returns) {
  return {
    version: 1,
    functions: {
      [functionName]: {
        args,
        returns,
      },
    },
  };
}

function buildDefinedFunctions(args, parameters = args.map((arg) => ({ name: arg.name, kind: 'POSITIONAL_OR_KEYWORD', has_default: Boolean(Object.prototype.hasOwnProperty.call(arg, 'default')) }))) {
  return {
    parameters,
  };
}

function buildModuleApi(functionName, args, returns, parameters = args.map((arg) => ({ name: arg.name, kind: 'POSITIONAL_OR_KEYWORD', has_default: Boolean(Object.prototype.hasOwnProperty.call(arg, 'default')) }))) {
  return validateModuleSchema(
    buildSchema(functionName, args, returns),
    {
      sourceLabel: `fixture:${functionName}`,
      definedFunctions: {
        [functionName]: buildDefinedFunctions(args, parameters),
      },
    },
  );
}

test('validateExportedFunctionResult accepts named multi-file returns declared with fields', () => {
  const moduleApi = buildModuleApi(
    'fit_t1rho_map',
    [
      { name: 'instance1', type: 'INSTANCE' },
      { name: 'output_dir', type: 'STRING' },
    ],
    {
      fields: [
        { name: 'output_dcm', type: 'FILE' },
        { name: 'preview_png', type: 'FILE' },
      ],
    },
  );

  const result = {
    output_dcm: {
      from: 'module',
      selection: {
        name: 'T1rho_Map.dcm',
        path: '/tmp/T1rho_Map.dcm',
        isFile: true,
      },
    },
    preview_png: {
      from: 'module',
      selection: {
        name: 'T1rho_Map_Preview.png',
        path: '/tmp/T1rho_Map_Preview.png',
        isFile: true,
      },
    },
  };

  assert.deepEqual(validateExportedFunctionResult(moduleApi, 'fit_t1rho_map', result), result);
});

test('validateExportedFunctionResult rejects named field returns when a declared field is missing', () => {
  const moduleApi = buildModuleApi(
    'fit_t1rho_map',
    [
      { name: 'instance1', type: 'INSTANCE' },
      { name: 'output_dir', type: 'STRING' },
    ],
    {
      fields: [
        { name: 'output_dcm', type: 'FILE' },
        { name: 'preview_png', type: 'FILE' },
      ],
    },
  );

  assert.throws(
    () => validateExportedFunctionResult(moduleApi, 'fit_t1rho_map', {
      output_dcm: {
        from: 'module',
        selection: {
          name: 'T1rho_Map.dcm',
          path: '/tmp/T1rho_Map.dcm',
          isFile: true,
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof ModuleSchemaValidationError);
      assert.equal(error.code, 'EXPORT_API_RETURN_VALUE_INVALID');
      assert.match(error.message, /missing field 'preview_png'/);
      return true;
    },
  );
});

test('validateExportedFunctionCall applies declared defaults to trailing optional args', () => {
  const moduleApi = buildModuleApi(
    'smooth',
    [
      { name: 'selection', type: 'INSTANCE' },
      { name: 'sigma', type: 'NUMBER', required: false, default: 0.3 },
      { name: 'output_dir', type: 'STRING', required: false, default: '/tmp/smooth' },
    ],
    { type: 'FILE' },
  );

  const selection = buildInstancePayload();

  assert.deepEqual(
    validateExportedFunctionCall(moduleApi, 'smooth', [selection]),
    [selection, 0.3, '/tmp/smooth'],
  );
});

test('validateExportedFunctionCall allows explicit null only for nullable args', () => {
  const nullableApi = buildModuleApi(
    'mpf_result',
    [
      { name: 'selection', type: 'INSTANCE' },
      { name: 'stats_file', type: 'FILE', required: false, nullable: true },
    ],
    { type: 'FILE' },
  );

  const selection = buildInstancePayload();

  assert.deepEqual(
    validateExportedFunctionCall(nullableApi, 'mpf_result', [selection, null]),
    [selection, null],
  );

  const nonNullableApi = buildModuleApi(
    'mpf_result',
    [
      { name: 'selection', type: 'INSTANCE' },
      { name: 'stats_file', type: 'FILE', required: false },
    ],
    { type: 'FILE' },
  );

  assert.throws(
    () => validateExportedFunctionCall(nonNullableApi, 'mpf_result', [selection, null]),
    (error) => {
      assert.ok(error instanceof ModuleSchemaValidationError);
      assert.equal(error.code, 'EXPORT_API_ARGUMENT_TYPE_INVALID');
      assert.match(error.message, /stats_file/);
      return true;
    },
  );
});

test('validateExportedFunctionCall rejects boolean values for NUMBER args', () => {
  const moduleApi = buildModuleApi(
    'smooth',
    [
      { name: 'selection', type: 'INSTANCE' },
      { name: 'sigma', type: 'NUMBER', required: false, default: 0.3 },
      { name: 'output_dir', type: 'STRING', required: false, default: '/tmp/smooth' },
    ],
    { type: 'FILE' },
  );

  assert.throws(
    () => validateExportedFunctionCall(moduleApi, 'smooth', [buildInstancePayload(), true, '/tmp/smooth']),
    (error) => {
      assert.ok(error instanceof ModuleSchemaValidationError);
      assert.equal(error.code, 'EXPORT_API_ARGUMENT_TYPE_INVALID');
      assert.match(error.message, /sigma/);
      return true;
    },
  );
});

test('validateExportedFunctionResult rejects FILE outputs that are not module-originated payloads', () => {
  const moduleApi = buildModuleApi(
    'smooth',
    [
      { name: 'selection', type: 'INSTANCE' },
      { name: 'sigma', type: 'NUMBER', required: false, default: 0.3 },
      { name: 'output_dir', type: 'STRING', required: false, default: '/tmp/smooth' },
    ],
    { type: 'FILE' },
  );

  assert.deepEqual(
    validateExportedFunctionResult(moduleApi, 'smooth', buildModuleFilePayload('smoothed_image.dcm', '/tmp/smoothed_image.dcm')),
    buildModuleFilePayload('smoothed_image.dcm', '/tmp/smoothed_image.dcm'),
  );

  assert.throws(
    () => validateExportedFunctionResult(moduleApi, 'smooth', {
      from: 'root',
      selection: {
        name: 'smoothed_image.dcm',
        path: '/tmp/smoothed_image.dcm',
        isFile: true,
      },
    }),
    (error) => {
      assert.ok(error instanceof ModuleSchemaValidationError);
      assert.equal(error.code, 'EXPORT_API_RETURN_VALUE_INVALID');
      assert.match(error.message, /must use FILE/);
      return true;
    },
  );
});

test('validateModuleSchema rejects declaration args that do not match Python signature names', () => {
  assert.throws(
    () => buildModuleApi(
      'smooth',
      [
        { name: 'selection', type: 'INSTANCE' },
        { name: 'sigma', type: 'NUMBER', required: false, default: 0.3 },
      ],
      { type: 'FILE' },
      [
        { name: 'selection_payload', kind: 'POSITIONAL_OR_KEYWORD', has_default: false },
        { name: 'sigma', kind: 'POSITIONAL_OR_KEYWORD', has_default: true },
      ],
    ),
    (error) => {
      assert.ok(error instanceof ModuleSchemaValidationError);
      assert.equal(error.code, 'MODULE_SCHEMA_FUNCTION_SIGNATURE_INVALID');
      assert.match(error.message, /selection.*selection_payload/);
      return true;
    },
  );
});
