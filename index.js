const { api_table_provider } = require("./api-table-provider.js");

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "saltcorn-tblprov-api",
  table_providers: {
    "Remote Saltcorn Table API": api_table_provider,
  },
};
