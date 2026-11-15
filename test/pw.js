// Playwright's Electron driver. The tests only need the library ("playwright-core", a devDependency of this
// project); a globally installed "playwright" works as well. No browser download is needed for Electron.
function load() {
  for (const name of ['playwright-core', 'playwright']) { try { return require(name); } catch { /* try the next one */ } }
  console.error('The Electron end-to-end tests need Playwright. Run "npm install" in the project folder (it installs playwright-core), then try again.');
  process.exit(1);
}
module.exports = load();
