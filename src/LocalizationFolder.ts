import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { FileMap, LineEndings } from "./";
const stringify = require("json-stable-stringify");

export default class LocalizationFolder {
  private hashes: Record<string, string> = {};
  private files: FileMap;
  private primaryLanguage: string;
  private isReportMode: boolean;

  constructor(files: FileMap, primaryLanguage: string, isReportMode: boolean) {
    this.files = files;
    this.primaryLanguage = primaryLanguage;
    this.isReportMode = isReportMode;
    this.hashes = {};
  }

  public populateFromDisk(filesToCreate: string[]) {
    const filesReadFromDisk = Object.keys(this.files).map((name) => {
      const fileContent = fs.readFileSync(name, "utf8");
      this.files[name] = JSON.parse(fileContent);
      this.hashes[name] = crypto
        .createHash("md5")
        .update(fileContent)
        .digest("hex");
      return path.basename(name, ".json");
    });
    const dirname = path.dirname(Object.keys(this.files)[0]);
    this.registerMissingFiles(filesToCreate, filesReadFromDisk, dirname);
  }

  private registerMissingFiles(
    shouldExist: string[],
    doExist: string[],
    dirname: string
  ) {
    for (const file of shouldExist) {
      if (doExist.indexOf(file) > -1) {
        continue;
      }

      const filename = path
        .join(dirname, file + ".json")
        .split(path.sep)
        .join("/");
      this.files[filename] = {};
      this.hashes[filename] = "";
    }
  }
  public updateFileContent(name: string, translatedObject: string) {
    const jsonData = JSON.parse(translatedObject);
    for (const key in jsonData) {
      const oldValue = this.files[name][key];

      if (oldValue !== undefined) {
        const newValue = jsonData[key];
        if (isObject(newValue))
          this.files[name][key] = deepMerge(
            this.files[name][key],
            jsonData[key]
          );
        else this.files[name][key] = jsonData[key];
      } else {
        this.files[name][key] = jsonData[key];
      }
    }

    // this.files[name] = JSON.parse(fileContent);
    this.hashes[name] = crypto
      .createHash("md5")
      .update(JSON.stringify(this.files[name]))
      .digest("hex");
    function isObject(value: any): value is { [key: string]: string } {
      return getTypeName(value) === "Object";
    }

    function getTypeName(object: any) {
      const fullName: string = Object.prototype.toString.call(object);
      return fullName.split(" ")[1].slice(0, -1);
    }
    function deepMerge(target: any, source: any) {
      let output = Object.assign({}, target);
      if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach((key) => {
          if (isObject(source[key])) {
            if (!(key in target)) {
              Object.assign(output, { [key]: source[key] });
            } else {
              output[key] = deepMerge(target[key], source[key]);
            }
          } else if (Array.isArray(source[key])) {
            output[key] = target[key]
              ? target[key].concat(source[key])
              : source[key];
          } else {
            Object.assign(output, { [key]: source[key] });
          }
        });
      }
      return output;
    }
  }

  public flushToDisk(
    jsonSpacing: string | number,
    lineEnding: LineEndings,
    addFinalNewline: boolean
  ) {
    const changedFiles: string[] = [];

    let space = jsonSpacing;
    if (typeof space === "string") {
      const numericSpace = parseInt(space, 10);
      if (!isNaN(numericSpace)) {
        space = numericSpace;
      }
    }

    Object.keys(this.files).forEach((name) => {
      let fileContent = stringify(this.files[name], { space });
      if (lineEnding === "CRLF") {
        fileContent = fileContent.replace(/\n/g, "\r\n");
      }

      if (addFinalNewline) {
        switch (lineEnding) {
          case "LF":
            fileContent += "\n";
            break;
          case "CRLF":
            fileContent += "\r\n";
            break;
        }
      }

      const hash = crypto.createHash("md5").update(fileContent).digest("hex");
      if (this.hashes[name] !== hash) {
        changedFiles.push(name);
      }

      if (!this.isReportMode) {
        fs.writeFileSync(name, fileContent, { encoding: "utf8" });
      }

      this.hashes[name] = null;
      this.files[name] = null;
    });

    return changedFiles;
  }

  public getSourceObject() {
    let source: Object;
    Object.keys(this.files).forEach((name) => {
      if (path.basename(name, ".json") === this.primaryLanguage) {
        source = this.files[name];
      }
    });
    return source;
  }

  public getTargetObject(name: string) {
    return this.files[name];
  }

  public getFilenames() {
    return Object.keys(this.files);
  }
}
