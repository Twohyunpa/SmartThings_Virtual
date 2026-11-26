'use strict';
// `npx github:Twohyunpa/SmartThings_Virtual` runs the bin named after the package when there is more
// than one bin. Keep one, pointing at the GUI server, or the plain npx command fails.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

it('has a bin named after the package that starts the GUI', () => {
  assert.equal(pkg.bin[pkg.name], 'server.js');
});
