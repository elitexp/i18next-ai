import * as glob from "glob";
import * as path from "path";
import ActionRecorder from "./ActionRecorder";
import LocalizationFolder from "./LocalizationFolder";
import pluralForms from "./pluralForms";

import OpenAI from "openai";
var Dot = require("dot-object");
const dot = new Dot("::");
require("dotenv").config();

export interface Options {
  /** Audit files in memory instead of changing them on the filesystem and throw an error if any changes would be made */
  check?: boolean;
  /** Glob pattern for the resource JSON files */
  files?: string;
  /** An array of glob patterns to exclude from the files search. Defaults to node_modules */
  excludeFiles?: string[];
  /** Primary localization language. Other language files will be changed to match */
  primary?: string;
  /** Language files to create if they don't exist, e.g. ['es, 'pt-BR', 'fr'] */
  createResources?: string[];
  /** Space value used for JSON.stringify when writing JSON files to disk */
  space?: string | number;
  /** Line endings used when writing JSON files to disk */
  lineEndings?: LineEndings;
  /** Insert a final newline when writing JSON files to disk */
  finalNewline?: boolean;
  /** Use empty string for new keys instead of the primary language value */
  newKeysEmpty?: boolean;
  /** Use OpenAI for translation */
  useOpenAI?: boolean;
}

export type DirectoryMap = Record<string, FileMap>;
export type FileMap = Record<string, object>;
export type LineEndings = "LF" | "CRLF";
type LocalizationValue = Record<string, string> | string;

export default async function cli({
  check: isReportMode = false,
  files = "**/locales/*.json",
  excludeFiles = ["**/node_modules/**"],
  primary: primaryLanguage = "en",
  createResources: createFiles = [],
  space: jsonSpacing = 4,
  lineEndings = "LF",
  finalNewline = false,
  newKeysEmpty = false,
  useOpenAI = true,
}: Options) {
  const allFiles = glob.sync(files, { ignore: excludeFiles });
  const directories = groupFilesByDirectory(allFiles);
  const openai = new OpenAI();

  let targetLanguage: string;
  let record: ActionRecorder;
  let hasAnyErrors = false;
  let hasAnyChanges = false;
  let hasValueChanges = false;
  for (const currentDirectory of Object.keys(directories)) {
    const folder = new LocalizationFolder(
      directories[currentDirectory],
      primaryLanguage,
      isReportMode
    );
    folder.populateFromDisk(createFiles);
    const sourceObject = folder.getSourceObject();
    if (!sourceObject) {
      continue;
    }

    for (const filename of folder.getFilenames()) {
      targetLanguage = normalizeLanguageFromFilename(filename).toUpperCase();

      record = new ActionRecorder(filename, isReportMode);
      syncObjects(sourceObject, folder.getTargetObject(filename));
      const addedKeys = record.getKeysAdded();

      if (addedKeys.length) {
        let mapping: Record<string, any> = {};
        for (const key of addedKeys) {
          let mappedValue = sourceObject[key];
          if (mappedValue === undefined && key.includes("::")) {
            mappedValue = findValueByKey(sourceObject, key);
          }
          if (mappedValue === undefined) {
            throw new Error(`Invalid key ${key} in ${filename}`);
          }
          mapping[key] = mappedValue;
        }
        var target = {};
        dot.dot(mapping, target);
        const chunkSize = 3000;
        let currentSize = 0;
        let currentChunk = {};
        let chunks = [];

        for (const key of Object.keys(target)) {
          const value = target[key];

          const pairSize = key.length + value.length;

          if (currentSize + pairSize <= chunkSize) {
            currentChunk[key] = value;
            currentSize += pairSize;
          } else {
            chunks.push({ ...currentChunk });
            currentChunk = { [key]: value };
            currentSize = pairSize;
          }
        }

        // Add the last chunk if it's not empty
        if (Object.keys(currentChunk).length > 0) {
          chunks.push(currentChunk);
        }

        if (openai && chunks.length > 0) {
          console.log(
            `Translating to '${targetLanguage}' for ${
              Object.keys(target).length
            } keys ...`
          );
          let convertedChunks: any = {};
          let fail = false;

          for (const chunk in chunks) {
            const chunkIndex = parseInt(chunk) + 1;
            console.log(`Translating chunk ${chunkIndex}/${chunks.length}`);
            var chunkData = JSON.stringify(chunks[chunk]);
            let tries = 1;

            if (useOpenAI) {
              do {
                try {
                  const response = await openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    messages: [
                      {
                        role: "system",
                        content: `I want you to act as a language translator, converting text from English to the language of the country with the ISO 3166-1 alpha-2 code '${targetLanguage}'. Your task is to translate only the 'value' part of the data provided in the format { 'key': 'value' }. It is crucial that the keys in the JSON object remain unchanged to ensure data integrity.

                        Please pay close attention to the accuracy of the language translation, considering the context and nuances of each value. The goal is to achieve translations that are not only technically correct but also contextually appropriate for the intended language.
                        
                        Ensure that all the keys of the data are translated and never miss a single key, as the main goal is to produce the technically correct JSON output for localization file. 

                        Ensure the translated 'value' parts are returned in a proper JSON format, with all original keys intact and no keys missing. This will prevent any errors during data processing. If you encounter any terms or phrases that are ambiguous or difficult to translate accurately, please maintain the original English text for those specific entries.

                        Here is the data that needs translation:
                        """"${chunkData}""""

                        Remember, the output should be a complete and accurate JSON object, reflecting the translated values while keeping all keys as they are. Your thoroughness and attention to detail in this translation process are crucial for the seamless use of the translate data."

                      `,
                      },
                    ],
                  });
                  console.log(response.choices[0].message.content);
                  var convertedJson = JSON.parse(
                    response.choices[0].message.content
                  );
                  // var convertedJson = JSON.parse(chunkData);
                  for (const key of Object.keys(convertedJson)) {
                    const value = convertedJson[key];
                    convertedChunks[key] = value;
                  }
                  break;
                } catch (error) {
                  tries++;
                  console.log(`Attempt ${tries} out of 5`);
                  if (tries > 5) {
                    fail = true;
                    break;
                  }
                }
              } while (true);
            } else {
              var chunkTarget = {};
              dot.dot(JSON.parse(chunkData), chunkTarget);
              convertedChunks = chunkTarget;
            }

            if (fail) {
              throw new Error(
                "[i18next-json-sync-ai] translation error -- unable to continue translation"
              );
            }
            var convertedData = dot.object(convertedChunks);
            folder.updateFileContent(filename, JSON.stringify(convertedData));
          }
        }
      }

      hasValueChanges = hasValueChanges || record.hasAnyActions();
      hasAnyErrors = hasAnyErrors || record.hasAnyErrors();
    }

    const changedFiles = folder.flushToDisk(
      jsonSpacing,
      lineEndings.toUpperCase() as LineEndings,
      finalNewline
    );

    hasAnyChanges = hasAnyChanges || changedFiles.length > 0;
  }

  if (hasAnyErrors) {
    throw new Error("[i18next-json-sync-ai] found keys unsafe to synchronize");
  }

  if (isReportMode) {
    if (hasValueChanges) {
      throw new Error(
        "[i18next-json-sync-ai] check failed -- keys are out of sync. Run again without check mode to synchronize files"
      );
    }
    if (hasAnyChanges) {
      throw new Error(
        "[i18next-json-sync-ai] check failed -- files have unordered keys or unexpected whitespace. Run again without check mode to correct files"
      );
    }
  }

  function groupFilesByDirectory(allFiles: string[]) {
    const directories: DirectoryMap = {};
    for (const filename of allFiles) {
      const directory = path.dirname(filename);
      directories[directory] = directories[directory] || {};
      directories[directory][filename] = null;
    }
    return directories;
  }

  function findValueByKey(obj: any, searchKey: string): any {
    if (searchKey.includes("::")) {
      const branches = searchKey.split("::");
      const branch = branches[0];
      const branchObj = obj[branch];
      if (!branchObj) return undefined;
      const subBranch = branches.slice(1);
      const subKey = subBranch.join("::");
      return findValueByKey(branchObj, subKey);
    } else return obj[searchKey];
  }

  function normalizeLanguageFromFilename(filename: string) {
    return path.basename(filename, ".json").replace(/-/g, "_").toLowerCase();
  }

  function syncObjects(source: Object, target: Object, parentKey: string = "") {
    mergeKeys(source, target, parentKey);

    for (const key of Object.keys(target)) {
      // const fullKey = parentKey ? `${parentKey}::${key}` : key;
      if (source.hasOwnProperty(key) && target.hasOwnProperty(key)) {
        // we should remove book_plural, book_1, etc if the language doesn't support singular forms
        if (
          typeof target[key] === "string" &&
          keyIsOnlyPluralForPrimary(
            key,
            Object.keys(source),
            Object.keys(target)
          )
        ) {
          removeKey(source, target, key);
        }
      } else if (!isValidMappedPluralForm(key, source, target)) {
        // don't remove valid mappings from book_plural to book_0
        removeKey(source, target, key);
      }
    }
  }

  function mergeKeys(source: Object, target: Object, parentKey: string = "") {
    for (const key of Object.keys(source)) {
      mergeKey(source, target, key, parentKey);
    }
  }

  function mergeKey(
    source: Object,
    target: Object,
    key: string,
    parentKey: string = ""
  ) {
    const fullKey = parentKey ? `${parentKey}::${key}` : key;
    const sourceValue: LocalizationValue = source[key];
    const targetValue: LocalizationValue = target[key];

    if (target.hasOwnProperty(key)) {
      if (areSameTypes(sourceValue, targetValue)) {
        if (isObject(sourceValue)) {
          syncObjects(sourceValue, targetValue, fullKey);
        } else if (
          keyMatchesPluralForLanguage(key, primaryLanguage) &&
          !keyMatchesPluralForLanguage(key, targetLanguage)
        ) {
          removeKey(source, target, key);
          mergeKeys(createPlurals(key, source), target, fullKey);
        }

        //base case: source and target agree on key name and value is string
      } else {
        record.error(
          (file) => `${file} contains type mismatch on key ${fullKey}`
        );
      }
    } else {
      copyValue(source, target, key, fullKey);
    }
  }

  function copyValue(
    source: Object,
    target: Object,
    key: string,
    fullKey: string
  ) {
    const sourceValue = source[key];
    if (isObject(sourceValue)) {
      //The source is the object
      if (!record.hasRootKey(fullKey)) {
        target[key] = {};
        record.keyAdded(fullKey);
        syncObjects(sourceValue, target[key], fullKey);
      }
    } else if (
      //do we need to transform plurals from e.g. x_plural to x_0?
      keyMatchesPluralForLanguageIncludingSingular(
        key,
        Object.keys(source),
        primaryLanguage
      ) &&
      !keyMatchesPluralForLanguage(key, targetLanguage) &&
      !pluralFormsMatch()
    ) {
      if (!targetPluralsPopulated(target, key)) {
        copyPlurals(createPlurals(key, source), target, fullKey);
      }
    } else {
      if (!record.hasRootKey(fullKey)) {
        target[key] = newKeysEmpty ? "" : sourceValue;
        record.keyAdded(fullKey);
      }
    }
  }

  function targetPluralsPopulated(target: object, key: string) {
    //given 'x' for key, do we have 'x' and 'x_plural' for en?
    const singular = getSingularForm(key);
    const pluralKeys = getPluralsForLanguage(targetLanguage).map((p) =>
      p.replace("key", singular)
    );
    const targetKeys = Object.keys(target);
    return pluralKeys.every(
      (expectedPluralKeys) => targetKeys.indexOf(expectedPluralKeys) > -1
    );
  }

  function copyPlurals(
    plurals: Object,
    target: Object,
    parentKey: string = ""
  ) {
    for (const key of Object.keys(plurals)) {
      const fullKey = parentKey ? `${parentKey}::${key}` : key;
      if (target.hasOwnProperty(key)) {
        continue;
      }
      target[key] = target[key] = newKeysEmpty ? "" : plurals[key];
      record.keyAdded(fullKey);
    }
  }

  function keyIsOnlyPluralForPrimary(
    key: string,
    allPimaryKeys: string[],
    allTargetKeys: string[]
  ) {
    if (pluralFormsMatch()) {
      return false;
    }

    if (languageOnlyHasOneForm(primaryLanguage)) {
      return false;
    }

    return (
      keyMatchesPluralForLanguageIncludingSingular(
        key,
        allPimaryKeys,
        primaryLanguage
      ) &&
      !keyMatchesPluralForLanguageIncludingSingular(
        key,
        allTargetKeys,
        targetLanguage
      )
    );
  }

  function pluralFormsMatch() {
    const primaryForms = Object.keys(getPluralsForLanguage(primaryLanguage));
    const targetForms = Object.keys(getPluralsForLanguage(targetLanguage));
    return (
      primaryForms.length === targetForms.length &&
      primaryForms.every((form) => targetForms.indexOf(form) > -1)
    );
  }

  function keyMatchesPluralForLanguageIncludingSingular(
    key: string,
    allKeys: string[],
    language: string
  ) {
    /**
     * It's impossible to tell whether a key is a plural for a language with one form shared between singular and plurals.
     * With other languages we can look for relationships between e.g. value and value_plural or value and value_0.
     */

    if (languageOnlyHasOneForm(language)) {
      return true;
    }

    const matchesAPlural = keyMatchesPluralForLanguage(key, language);
    if (matchesAPlural) {
      return true;
    }

    //key is now a singular form
    if (!languageHasSingularForm(language)) {
      return false;
    }

    for (const _key of allKeys) {
      if (key !== _key && isPluralFormForSingular(_key, key, language)) {
        return true;
      }
    }

    return false;
  }

  function keyMatchesPluralForLanguage(key: string, language: string) {
    const forms = getPluralsForLanguage(language).map((form) =>
      form.replace("key", "")
    );

    for (const form of forms) {
      if (form && key.endsWith(form)) {
        return true;
      }
    }

    return false;
  }

  function isValidMappedPluralForm(
    key: string,
    sourceObject: Object,
    targetObject: Object
  ) {
    const singular = getSingularForm(key);
    const isPluralForPrimaryLanguage = Object.keys(sourceObject).some((key) =>
      isPluralFormForSingular(key, singular, primaryLanguage)
    );

    if (languageOnlyHasOneForm(targetLanguage)) {
      return singular === key && isPluralForPrimaryLanguage;
    }

    const isPluralForTargetLanguage = Object.keys(targetObject).some((key) =>
      isPluralFormForSingular(key, singular, targetLanguage)
    );
    return isPluralForPrimaryLanguage && isPluralForTargetLanguage;
  }

  function getSingularForm(key: string) {
    return key.replace(/_(plural|\d)$/, "");
  }

  function isPluralFormForSingular(
    key: string,
    singular: string,
    language: string
  ) {
    return (
      getPluralsForLanguage(language)
        .map((form) => form.replace("key", singular))
        .indexOf(key) > -1
    );
  }

  function languageHasSingularForm(language: string) {
    return (
      getPluralsForLanguage(language)
        .map((form) => form.replace("key", ""))
        .indexOf("") > -1
    );
  }

  function languageOnlyHasOneForm(language: string) {
    return getPluralsForLanguage(language).length === 1;
  }

  function getPluralsForLanguage(language: string) {
    if (pluralForms.hasOwnProperty(language)) {
      return pluralForms[language];
    }

    if (language.indexOf("_") > -1 || language.indexOf("-") > -1) {
      const baseLanguage = language.split(/-|_/)[0];
      if (pluralForms.hasOwnProperty(baseLanguage)) {
        return pluralForms[baseLanguage];
      }
    }

    return [];
  }

  function createPlurals(key: string, source: Object) {
    const singular = getSingularForm(key);
    const plurals = {};

    if (languageOnlyHasOneForm(primaryLanguage)) {
      plurals[key] = source[key];
    } else {
      const fillValue = getPluralFillValue(singular, source);
      for (const form of getPluralsForLanguage(targetLanguage)) {
        plurals[form.replace("key", singular)] = fillValue;
      }
    }

    return plurals;
  }

  function getPluralFillValue(singular: string, source: Object) {
    if (languageOnlyHasOneForm(primaryLanguage)) {
      return source[singular];
    }

    //prefer plural fill values because they're more likely to have
    //interpolations like {{ count }}, but fall back to singular
    const sourceKeys = Object.keys(source).filter((k) => k !== singular);
    for (const form of getPluralsForLanguage(primaryLanguage)) {
      const pluralKey = form.replace("key", singular);
      if (sourceKeys.indexOf(pluralKey) > -1) {
        return source[pluralKey];
      }
    }

    return source[singular];
  }

  function removeKey(source: Object, target: Object, key: string) {
    if (isObject(target[key])) {
      gatherKeysFor(target[key]).forEach((k) => record.keyRemoved(k));
    } else {
      record.keyRemoved(key);
    }

    //base case: key in target not found in source
    delete target[key];
  }

  function gatherKeysFor(object: Object) {
    return Object.keys(object)
      .map((key) => gatherPrimitivesForSingleKey(object, key))
      .reduce((all, next) => all.concat(next), []);
  }

  function gatherPrimitivesForSingleKey(object: Object, key: string): string[] {
    if (isObject(object[key])) {
      return gatherKeysFor(object[key]);
    } else {
      return [key];
    }
  }
}

function isObject(value: any): value is { [key: string]: string } {
  return getTypeName(value) === "Object";
}

function areSameTypes(value: any, otherValue: any) {
  return getTypeName(value) === getTypeName(otherValue);
}

function getTypeName(object: any) {
  const fullName: string = Object.prototype.toString.call(object);
  return fullName.split(" ")[1].slice(0, -1);
}
