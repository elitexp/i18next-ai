[![Build Status](https://travis-ci.org/elitexp/i18next-ai.svg?branch=master)](https://travis-ci.org/elitexp/i18next-ai)
[![npm](https://img.shields.io/npm/v/i18next-ai.svg)](https://www.npmjs.com/package/i18next-json-sync-ai)
# i18next-json-sync-ai

Keeps [i18next-ai](https://github.com/elitexp/i18next-ai) JSON resource files in sync against a primary
language, forked form [i18next](https://github.com/jwbay/i18next-json-sync), including plural forms. When hooked up to a build process/CI server, ensures keys
added/removed from one language are correctly propagated to the other languages, reducing the chance
for missing or obselete keys, merge conflicts, and typos.

With the added capability to traverse in-depth of the JSON files, it syncs the JSON files completely, no matter how deep you go down.

## Example
Given these files:
```
 locales
 ├── en.json
 ├── fr.json
 └── ru.json
```

```json
en.json
{
  "key_one": "value",
  "book": "book",
  "book_plural": "books"
}

fr.json
{
  "key_one": "french value"
}

ru.json
{
  "extra_key": "extra value"
}
```


`fr.json` and `ru.json` can be synced against `en.json`:

```js
import sync from 'i18next-json-sync'
sync({
  files: 'locales/*.json',
  primary: 'en'
});
```

resulting in:

```json
en.json
{
  "key_one": "value",
  "book": "book",
  "book_plural": "books"
}

fr.json
{
  "key_one": "french value",
  "book": "book",
  "book_plural": "books"
}

ru.json
{
  "key_one": "value",
  "book_0": "books",
  "book_1": "books",
  "book_2": "books"
}
```

`key_one` was left alone in fr.json since it's already localized, but `book` and `book_plural` were copied over.
An extraneous key in ru.json was deleted and keys from en.json copied over.

This works on one folder at a time, but can deal with whatever the files glob returns. Files are
grouped into directories before processing starts. Folders without a 'primary' found are ignored.

## Usage

`$ npm install i18next-json-sync-ai --save-dev`

#### In node.js

```js
import sync from 'i18next-json-sync-ai';
//or in ES5 world:
//const sync = require('i18next-json-sync-ai').default;

//defaults are inline:
sync({
  /** Audit files in memory instead of changing them on the filesystem and
    * throw an error if any changes would be made */
  check: false,
  /** Glob pattern for the resource JSON files */
  files: '**/locales/*.json',
  /** An array of glob patterns to exclude from the files search */
  excludeFiles: ['**/node_modules/**'],
  /** Primary localization language. Other language files will be changed to match */
  primary: 'en',
  /** Language files to create if they don't exist, e.g. ['es, 'pt-BR', 'fr'] */
  createResources: [],
  /** Space value used for JSON.stringify when writing JSON files to disk */
  space: 4,
  /** Line endings used when writing JSON files to disk. Either LF or CRLF */
  lineEndings: 'LF',
  /** Insert a final newline when writing JSON files to disk */
  finalNewline: false,
  /** Use empty string for new keys instead of the primary language value */
  newKeysEmpty: false
  /** Use OpenAI for translation */
  useOpenAi: true
})
```

#### CLI

It can be installed globally and run with `sync-i18n`, but [package.json scripts](https://docs.npmjs.com/misc/scripts) are a better fit.

```json
{
  "name": "my-app",
  "scripts": {
    "i18n": "sync-i18n --files '**/locales/*.json' --primary en --languages es fr ja zh ko --space 2",
    "check-i18n": "npm run i18n -- --check"
  }
}
```

Then use `npm run i18n` to sync on the filesystem and `npm run check-i18n` to validate.

All options are available via CLI. Use `-h` or `--help` to get help output.

## License

[MIT](LICENSE)
