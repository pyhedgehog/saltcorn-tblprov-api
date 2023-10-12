const Workflow = require("@saltcorn/data/models/workflow");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
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
  console.log("api_configuration_workflow =", req.body);
  return new Workflow({
    steps: [
      {
        name: "url",
        form: async function api_configuration_workflow_step1form_url(context) {
          const tbl = Table.findOne({ id: context.table_id });
          console.log(
            "api_configuration_workflow/url(1) =",
            context,
            tbl,
            arguments,
          );
          console.dir(context);
          return new Form({
            fields: [
              {
                name: "raw_url",
                label: "Use URL as is",
                sublabel: "don't append /api/{remote_name}",
                required: true,
                default: false,
                type: "Bool",
              },
              {
                name: "http_method",
                label: "Method of HTTP request",
                type: "String",
                required: true,
                default: "GET",
                attributes: { options: "GET,POST,PUT" },
                showIf: { raw_url: true },
              },
              {
                name: "url",
                label: "API URL",
                required: true,
                type: "String",
              },
              {
                name: "auth_type",
                parent_field: "auth",
                label: "API authorization type",
                type: "String",
                default: "token",
                attributes: {
                  options: "public,token,basic",
                  // options: "public,token,password",
                },
              },
              {
                name: "token",
                parent_field: "auth",
                label: "API token",
                type: "String",
                showIf: { auth_type: "token" },
              },
              {
                name: "basic",
                parent_field: "auth",
                label: "Basic HTTP authorization",
                sublabel: "Use 'username:password' form.",
                type: "String",
                showIf: { auth_type: "basic" },
              },
              {
                name: "remote_name",
                label: "Name of remote table",
                type: "String",
                required: true,
                default: tbl.name,
                showIf: { raw_url: false },
              },
              {
                name: "scapi",
                label: "Use admin API",
                sublabel: "Retrieve table description via SCAPI",
                type: "Bool",
                required: true,
                default: false,
                showIf: { raw_url: false },
              },
            ],
          });
        },
      },
      {
        name: "fields",
        form: async function api_configuration_workflow_step2form_scapi(
          context,
        ) {
          console.log("api_configuration_workflow/fields(2) =", context);
          const tbl = Table.findOne({ id: context.table_id });
          let fields = null;
          let warnings = [];
          if (context.scapi) {
            const remote_tbl = await api_scapi_table(context);
            console.log("remote_tbl =", remote_tbl);
            fields = remote_tbl.fields.map(function convert_field(field) {
              let fld = Object.fromEntries(Object.entries(field).filter(([k,v])=>(v!==null&&v!==false)));
              fld.type =
                typeof fld.type === "object" ? fld.type.name : fld.type;
              if (fld.type === "Key") fld.type = fld.reftype;
              if (!fld.description) delete fld.description;
              if(typeof fld.attributes == "object")
                fld.attributes = Object.fromEntries(Object.entries(fld.attributes).filter(([k,v])=>(v!==null)));
              if(fld.attributes && Object.keys(fld.attributes) == 0)
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
            console.log("stripped scapi fields =", fields);
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
              if (name === "id") fld.label = 'ID';
              else fld.label = name.replace(/(^|_)(.)/g,(_,a,b)=>`${a}${b.toUpperCase()}`);
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
                console.log(warn);
                fld.type = "String";
              } else if (colNNTypes[0] == "boolean") fld.type = "Bool";
              else if (colNNTypes[0] == "string")
                fld.type = values.filter((v) => !!v).every(isDate)
                  ? "Date"
                  : "String";
              else if (colNNTypes[0] == "number")
                fld.type = values
                  .filter((v) => !!v)
                  .every((i) => Math.trunc(i) === i)
                  ? "Integer"
                  : "Float";
              else {
                const warn = `Can't detect type for field ${name} from JS type ${colNNTypes}.`;
                warnings.push(warn);
                console.log(warn);
                fld.type = "String";
              }
              return fld;
            });
            console.log("detected fields =", fields);
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
  console.log("api_get_fields = ", cfg, arguments);
  return (
    (cfg || {}).fields || [
      { name: "id", label: "ID", type: "Integer", primary_key: true },
    ]
  );
}

async function api_get_table_rows(cfg, where) {
  console.log("api_get_table_rows =", { cfg, where });
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
  console.log("fetch_options =", fetch_options);
  console.log("url =", url);
  const resp = await fetch(url, fetch_options);
  console.log(`Response status ${resp.status} ${resp.statusText} from ${url0}`);
  if (!resp.ok)
    throw new Error(
      `Response error ${resp.status} ${resp.statusText} from ${url0}`,
    );
  const data = await resp.json();
  if (!data || !data.success)
    throw new Error(`Invalid response ${JSON.stringify(data)} from ${url}`);
  if (data.success === true && data.data) return data.data;
  return data.success;
}

function api_get_table(cfg, tbl) {
  console.log("api_get_table = ", cfg, arguments);
  return {
    getRows: (where) => api_get_table_rows(cfg, where),
  };
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
