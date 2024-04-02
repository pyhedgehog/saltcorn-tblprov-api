const Workflow = require("@saltcorn/data/models/workflow");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const { getState } = require("@saltcorn/data/db/state");
const fetch = require("node-fetch");
fetch.Promise = Promise;
const { stateToQueryString } = require("@saltcorn/data/plugin-helper");
const markupTags = require("@saltcorn/markup/tags");

function getAuthHeaders(auth) {
  return auth.auth_type === "public"
    ? []
    : [
        [
          "Authorization",
          auth.auth_type === "token"
            ? `Bearer ${auth.token}`
            : `Basic ${Buffer.from(auth.basic).toString("base64")}`,
        ],
      ];
}

async function api_scapi_table(cfg) {
  if (cfg.raw_url)
    throw new Error(
      "Can't request remote table information if cfg.raw_url set.",
    );
  if (!cfg.scapi)
    throw new Error(
      "Can't request remote table information if cfg.scapi not set.",
    );
  const url = `${cfg.url}/scapi/sc_tables`;
  const urlo = new URL(url);
  const resp = await fetch(url, {
    headers: [["Host", urlo.host], ...getAuthHeaders(cfg.auth)],
  });
  if (!resp.ok)
    throw new Error(
      `Response error ${resp.status} ${resp.statusText} from ${url}`,
    );
  const data = await resp.json();
  if (!data || !data.success)
    throw new Error(`Invalid response ${JSON.stringify(data)} from ${url}`);
  const sc_tables = Object.fromEntries(data.success.map((o) => [o.name, o]));
  return sc_tables[cfg.remote_name];
}

function api_configuration_workflow(req) {
  console.log("logLevel =", getState().logLevel);
  getState().log(4, "api_configuration_workflow =", req.body);
  return new Workflow({
    steps: [
      {
        name: "url",
        form: async function api_configuration_workflow_step1form_url(context) {
          //const tbl = Table.findOne({ id: context.table_id });
          const tbl = await Table.find_with_external(
            { id: context.table_id },
            { cached: false },
          )[0];
          console.log(
            `api/step1/url = ${JSON.stringify(context)}; ${JSON.stringify(tbl)}`,
          );
          getState().log(
            4,
            "api/step1/url: context =",
            context,
            "; tbl =",
            tbl,
          );
          if ((context || {}).auth) Object.assign(context, context.auth);
          else (context || {}).auth = {};
          console.log("state =", getState());
          console.log("Bool =", Object.keys(getState().types));
          function formfield_factory(fld) {
            if (false) return new Field(fld);
            return fld;
          }
          return new Form({
            fields: [
              formfield_factory({
                name: "raw_url",
                label: "Use URL as is",
                sublabel: "don't append /api/{remote_name}",
                required: true,
                default: false,
                type: "Bool",
              }),
              formfield_factory({
                name: "http_method",
                label: "Method of HTTP request",
                type: "String",
                required: true,
                default: "GET",
                attributes: { options: "GET,POST,PUT" },
                showIf: { raw_url: true },
              }),
              formfield_factory({
                name: "url",
                label: "API URL",
                required: true,
                type: "String",
              }),
              formfield_factory({
                name: "auth_type",
                parent_field: "auth",
                label: "API authorization type",
                type: "String",
                default: "token",
                attributes: {
                  options: "public,token,basic",
                  // options: "public,token,password",
                },
              }),
              formfield_factory({
                name: "token",
                parent_field: "auth",
                label: "API token",
                type: "String",
                showIf: { auth_type: "token" },
              }),
              formfield_factory({
                name: "basic",
                parent_field: "auth",
                label: "Basic HTTP authorization",
                sublabel: "Use 'username:password' form.",
                type: "String",
                showIf: { auth_type: "basic" },
              }),
              formfield_factory({
                name: "remote_name",
                label: "Name of remote table",
                type: "String",
                required: true,
                default: (tbl || {}).name,
                showIf: { raw_url: false },
              }),
              formfield_factory({
                name: "scapi",
                label: "Use admin API",
                sublabel: "Retrieve table description via SCAPI",
                type: "Bool",
                required: true,
                default: false,
                showIf: { raw_url: false },
              }),
              formfield_factory({
                name: "error_handling",
                label: "What to do in case of request error",
                type: "String",
                required: true,
                default: (tbl || {}).error_handling || "empty",
                attributes: {
                  options: [
                    Object.assign(String("pass"), {
                      name: "pass",
                      value: "pass",
                      label: "Throw exception outside (not recommended)",
                    }),
                    Object.assign(String("empty"), {
                      name: "empty",
                      value: "empty",
                      label: "Return empty rowset",
                    }),
                    Object.assign(String("column"), {
                      name: "column",
                      value: "column",
                      label:
                        "Return one row with error in first available text column",
                    }),
                    Object.assign(String("error"), {
                      name: "error",
                      value: "error",
                      label:
                        "Return one row with error in distinct 'error' column",
                    }),
                  ],
                  // options: "public,token,password",
                },
              }),
            ],
          });
        },
      },
      {
        name: "fields",
        form: async function api_configuration_workflow_step2form_fields(
          context,
        ) {
          const tbl = await Table.find_with_external(
            { id: context.table_id },
            { cached: true },
          )[0];
          getState().log(5, `api/step1/fields = ${context}, ${tbl}`);
          let fields = null;
          let warnings = [];
          if (context.scapi) {
            const remote_tbl = await api_scapi_table(context);
            getState().log(4, `remote_tbl = ${remote_tbl}`);
            fields = remote_tbl.fields.map(function convert_field(field) {
              let fld = Object.fromEntries(
                Object.entries(field).filter(
                  ([k, v]) => v !== null && v !== false,
                ),
              );
              fld.type =
                typeof fld.type === "object" ? fld.type.name : fld.type;
              if (fld.type === "Key") fld.type = fld.reftype;
              if (!fld.description) delete fld.description;
              if (typeof fld.attributes == "object")
                fld.attributes = Object.fromEntries(
                  Object.entries(fld.attributes).filter(([k, v]) => v !== null),
                );
              if (fld.attributes && Object.keys(fld.attributes) == 0)
                delete fld.attributes;
              delete fld.id;
              delete fld.table_id;
              delete fld.expression;
              delete fld.calculated;
              delete fld.stored;
              delete fld.input_type;
              delete fld.reftype;
              delete fld.refname;
              delete fld.reftable_name;
              delete fld.typename;
              delete fld.class;
              delete fld.hidden;
              delete fld.disabled;
              delete fld.is_fkey;
              return fld;
            });
            getState().log(4, `stripped scapi fields = ${fields}`);
          } else {
            const rows = await api_get_table_rows(context);
            const fieldNames = new Set(rows.map((r) => Object.keys(r)).flat());
            const columns = Array.from(fieldNames).map((fn) => [
              fn,
              rows.map((r) => r[fn]),
            ]);
            let tlb_info = { primary_key: null };
            fields = columns.map(([name, values]) => {
              let fld = { name };
              if (name === "id") fld.primary_key = true;
              if (name === "id") fld.label = "ID";
              else
                fld.label = name.replace(
                  /(^|_)(.)/g,
                  (_, a, b) => `${a}${b.toUpperCase()}`,
                );
              if (new Set(values).length == values.length) fld.unique = true;
              if (
                !fieldNames.has("id") &&
                !tlb_info.primary_key &&
                fld.unique
              ) {
                fld.primary_key = true;
                tlb_info.primary_key = name;
              }
              const colTypes = new Set(
                values.map((v) => (v === null ? "null" : typeof v)),
              );
              const colNNTypes = Array.from(colTypes).filter(
                (tp) => tp != "null" && tp != "undefined",
              );
              if (!colTypes.has("null") && !colTypes.has("undefined"))
                fld.required = true;
              if (colTypes.has("object")) fld.type = "JSON";
              else if (colNNTypes.length != 1) {
                const warn = `Can't detect type for field ${name} there are ${colNNTypes.length} non-empty types (${colNNTypes}).`;
                warnings.push(warn);
                getState().log(2, warn);
                fld.type = "String";
              } else if (colNNTypes[0] == "boolean") {
                fld.type = "Bool";
              } else if (colNNTypes[0] == "string") {
                if (values.filter((v) => !!v).every(isDate)) fld.type = "Date";
                else if (
                  values
                    .filter((v) => !!v)
                    .every((v) => /^#[0-9a-fA-Z]{6}$/.test(v))
                )
                  fld.type = "Color";
                else fld.type = "String";
              } else if (colNNTypes[0] == "number") {
                fld.type = values
                  .filter((v) => !!v)
                  .every((i) => Math.trunc(i) === i)
                  ? "Integer"
                  : "Float";
              } else {
                const warn = `Can't detect type for field ${name} from JS type ${colNNTypes}.`;
                warnings.push(warn);
                getState().log(2, warn);
                fld.type = "String";
              }
              return fld;
            });
            getState().log(4, `detected fields = ${fields}`);
          }
          context.fields = fields;
          //context["fields-json"] = JSON.stringify(fields, null, 2);
          return new Form({
            fields: [
              ...(warnings.length > 0
                ? [
                    {
                      label: "Warnings due types detection",
                      input_type: "custom_html",
                      attributes: {
                        html: markupTags.pre(escapeHtml(warnings.join("\n"))),
                      },
                    },
                  ]
                : []),
              context.scapi
                ? {
                    label: "Check field definitions",
                    input_type: "custom_html",
                    attributes: {
                      html: markupTags.pre(
                        escapeHtml(JSON.stringify(fields, null, 2)),
                      ),
                    },
                  }
                : {
                    name: "fields",
                    label: "Review field definitions",
                    type: "JSON",
                    input_type: "custom_html",
                    fieldview: "edit",
                    attributes: {
                      html: markupTags.textarea(
                        {
                          class: ["form-control"],
                          style: "height:400px;",
                          "data-fieldname": "fields",
                          name: "fields",
                          id: "inputfields",
                        },
                        escapeHtml(JSON.stringify(fields, null, 2)),
                      ),
                    },
                  },
            ],
          });
        },
      },
    ],
  });
}

async function api_get_fields(cfg) {
  getState().log(4, `api_get_fields = ${cfg}`);
  var fields = (cfg || {}).fields || [
    {
      name: "id",
      label: "ID",
      type: "Integer",
      primary_key: true,
      required: true,
      is_unique: true,
    },
  ];
  var want_error_column = false;
  if ((cfg || {}).error_handling == "error")
    want_error_column =
      fields.filter((fld) => fld.name == "error").length === 0;
  if ((cfg || {}).error_handling == "column")
    want_error_column =
      fields.filter((fld) => fld.type == "String").length === 0;
  if (want_error_column) {
    fields.push({
      name: "error",
      type: "String",
      label: "Error message",
      required: false,
    });
  }
  return fields;
}

async function api_get_table_rows(cfg, where) {
  getState().log(1, `api_get_table_rows = ${{ cfg, where }}`);
  const state = whereToViewState(where);
  const url0 = cfg.raw_url ? cfg.url : `${cfg.url}/api/${cfg.remote_name}`;
  const url =
    cfg.raw_url && cfg.http_method.toLowerCase() != "get"
      ? url0
      : url0 + stateToQueryString(state);
  const urlo = new URL(url);
  const fetch_options = {
    ...(cfg.raw_url ? { method: cfg.http_method } : {}),
    ...(cfg.raw_url && cfg.http_method.toLowerCase() != "get"
      ? { body: JSON.stringify(state) }
      : {}),
    headers: [
      ["Host", urlo.host],
      ...getAuthHeaders(cfg.auth),
      ...(cfg.raw_url && cfg.http_method.toLowerCase() != "get"
        ? [["Content-type", "application/json"]]
        : []),
    ],
  };
  getState().log(4, `url = ${url}`);
  if ((cfg || {}).error_handling == "error") {
    cfg.error_column = "error";
  }
  if ((cfg || {}).error_handling == "column") {
    const str_columns = cfg.fields.filter((fld) => fld.type == "String");
    cfg.error_column = str_columns.length === 0 ? "error" : str_columns[0].name;
  }
  const resp = await fetch(url, fetch_options);
  if (!resp.ok)
    return _process_error(
      cfg,
      `Response error ${resp.status} ${resp.statusText} from ${url0}`,
    );
  getState().log(
    4,
    `Response status ${resp.status} ${resp.statusText} from ${url0}`,
  );
  const data = await resp.json();
  if (!data || !data.success)
    return _process_error(
      cfg,
      `Invalid response ${JSON.stringify(data)} from ${url}`,
    );
  if (data.success === true && data.data) return data.data;
  return data.success;

  function _process_error(cfg, error) {
    getState().log(2, `Error fetching remote table: ${error}`);
    getState().log(
      4,
      `cfg.error_handling = ${cfg.error_handling}, cfg.error_column = ${cfg.error_column}`,
    );
    if (cfg.error_handling === "column" || cfg.error_handling === "error") {
      return [{ id: 0, [cfg.error_column]: error }];
    }
    if (cfg.error_handling === "pass") throw new Error(error);
    return [];
  }
}

function api_get_table(cfg, tbl) {
  getState().log(4, `api_get_table = ${cfg}`);
  return Object.assign(tbl, {
    getRows: (where) => api_get_table_rows(cfg, where),
  });
}

const addOrCreateList = (container, key, x) => {
  if (container[key]) {
    if (container[key].length) container[key].push(x);
    else container[key] = [container[key], x];
  } else container[key] = [x];
};

function whereToViewState(where) {
  const state = {};
  if (!where || Object.keys(where).length === 0) return {};
  Object.entries(where).forEach(function ([k, v]) {
    if (k === "_fts" && v.searchTerm) {
      state[k] = v.searchTerm;
    } else if (Array.isArray(v)) {
      v.forEach(function (v1) {
        if (k === "id" && v1.inSelectWithLevels) {
          // FIXME
          addOrCreateList(
            state,
            _inbound_relation_path_,
            v1.inSelectWithLevels,
          );
        } else if (v1.gt && Object.getPrototypeOf(v1.gt).constructor === Date) {
          state[`_fromdate_${k}`] = v1.gt.toISOString();
        } else if (v1.lt && Object.getPrototypeOf(v1.lt).constructor === Date) {
          state[`_todate_${k}`] = v1.lt.toISOString();
        } else if (v1.gt) {
          state[`_gte_${k}`] = v1.gt;
        } else if (v1.lt) {
          state[`_lte_${k}`] = v1.lt;
        }
      });
    } else {
      state[k] = v;
    }
  });
  return state;
}

function isDate(o) {
  if (!o) return false;
  if (typeof o === "object")
    return Object.getPrototypeOf(o).constructor === Date;
  if (typeof o !== "string") return false;
  try {
    const dt = new Date(o);
    return o === dt.toJSON();
  } catch (e) {
    return false;
  }
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

module.exports = {
  api_configuration_workflow,
  api_get_fields,
  api_get_table,
  api_get_table_rows,
  api_table_provider: {
    configuration_workflow: api_configuration_workflow,
    fields: api_get_fields,
    get_table: api_get_table,
  },
};
