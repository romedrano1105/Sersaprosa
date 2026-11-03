const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("todayISO usa la fecha de El Salvador, no la zona horaria del navegador", () => {
  const window = {};
  const codigo = fs.readFileSync(path.join(__dirname, "../../public/assets/js/core/api.js"), "utf8");
  vm.runInNewContext(codigo, { window, Intl, Date });

  assert.equal(window.Api.todayISO(new Date("2026-11-02T05:30:00Z")), "2026-11-01");
});
