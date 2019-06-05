"use strict";

const pkg = require("./package.json");
const path = require("path");
const pLimit = require("p-limit");
const Worker = require("jest-worker").default;
const { globAndZip } = require("./util/bundle");

const SLS_TMP_DIR = ".serverless";
const PLUGIN_NAME = pkg.name;

// Timer and formatter.
// eslint-disable-next-line no-magic-numbers
const elapsed = (start) => ((new Date() - start) / 1000).toFixed(2);

// Simple, stable union.
const union = (arr1, arr2) => {
  const set1 = new Set(arr1);
  return arr1.concat(arr2.filter((o) => !set1.has(o)));
};

/**
 * Package Serverless applications manually.
 *
 * ## How it works
 *
 * Essentially, the plugin "tricks" Serverless into thinking that an artifact
 * is specified, which skips all normal Serverless packaging, and then does
 * the packaging manually.
 *
 * Functionally, this looks something like:
 * 1. Looks for any services and/or functions that the Serverless framework
 *    would publish with its built-in logic,
 * 2. Disables this by setting `service|function.pacakge.artifact` fields in
 *    the runtime Serverless configuration object, and;
 * 3. Invoking scripts to create an artifact that matches the newly-set
 *    `.artifact` paths in configuration
 *
 * ## Application
 *
 * This plugin only is invoked to create custom packages if default Serverless
 * packaging would apply. Notably, this means this plugin is a noop for
 * scenarios including:
 * - `service.package.artifact`
 * - `function.package.artifact`
 * - `function.package.disable`
 *
 * The plugin does apply and follows the logic of configurations that include:
 * - `service.package.individually`
 * - `function.package.individually`
 */
class Jetpack {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.commands = {
      jetpack: {
        usage: "Alternate Serverless packager",
        commands: {
          "package": {
            usage: "Packages a Serverless service or function",
            lifecycleEvents: [
              "package"
            ],
            options: {
              "function": {
                usage: "Function name. Packages a single function (see 'deploy function')",
                shortcut: "f"
              }
            }
          }
        }
      }
    };

    this.hooks = {
      "before:package:createDeploymentArtifacts": this.package.bind(this),
      "before:package:function:package": this.package.bind(this),
      "jetpack:package:package": this.package.bind(this)
    };
  }

  _log(msg) {
    const { cli } = this.serverless;
    cli.log(`[${PLUGIN_NAME}] ${msg}`);
  }

  _logDebug(msg) {
    if (process.env.SLS_DEBUG) {
      this._log(msg);
    }
  }

  // Root options.
  get _serviceOptions() {
    if (this.__options) { return this.__options; }

    const { service } = this.serverless;
    const defaults = {
      base: ".",
      roots: null
    };

    const custom = (service.custom || {}).jetpack;
    this.__options = Object.assign({}, defaults, custom, this.options);

    return this.__options;
  }

  // Function overrides, etc.
  _functionOptions({ functionObject }) {
    if (!functionObject) {
      return this._serviceOptions;
    }

    const opts = Object.assign({}, this._serviceOptions);
    const fnOpts = functionObject.jetpack || {};
    if (fnOpts.roots) {
      opts.roots = (opts.roots || []).concat(fnOpts.roots);
    }

    return opts;
  }

  filePatterns({ functionObject }) {
    const { service, pluginManager } = this.serverless;
    const servicePackage = service.package;
    const serviceInclude = servicePackage.include || [];
    const serviceExclude = servicePackage.exclude || [];

    const functionPackage = (functionObject || {}).package || {};
    const functionInclude = functionPackage.include || [];
    const functionExclude = functionPackage.exclude || [];

    // Combined, unique patterns, in stable sorted order (remove _later_ instances).
    // This is `_.union` in serverless built-in.
    const include = union(serviceInclude, functionInclude);

    // Packaging logic.
    //
    // We essentially recreate what `serverless` does:
    // - Default excludes
    // - Exclude serverless config files
    // - Exclude plugin local paths
    // - Apply service package excludes
    // - Apply function package excludes
    //
    // https://serverless.com/framework/docs/providers/aws/guide/packaging#exclude--include
    // > At first it will apply the globs defined in exclude. After that it'll
    // > add all the globs from include. This way you can always re-include
    // > previously excluded files and directories.
    //
    // Start with serverless excludes, plus a few refinements.
    const slsDefaultExcludePatterns = [
      ".git/**",
      ".gitignore",
      ".DS_Store",
      ".serverless/**",
      ".serverless_plugins/**",

      // Additional things no-one wants.
      "npm-debug.log*",
      "yarn-error.log*"
    ];

    // Get plugin local path.
    const pluginsLocalPath = pluginManager.parsePluginsObject(service.plugins).localPath;

    // Unify in similar order to serverless.
    const exclude = [
      slsDefaultExcludePatterns,
      pluginsLocalPath ? [pluginsLocalPath] : null,
      serviceExclude,
      functionExclude
    ]
      .filter((arr) => !!arr && arr.length)
      .reduce((memo, arr) => union(memo, arr), []);

    return {
      include,
      exclude
    };
  }

  async globAndZip({ bundleName, functionObject }) {
    const { config } = this.serverless;
    const servicePath = config.servicePath || ".";
    const { base, roots } = this._functionOptions({ functionObject });
    const { include, exclude } = this.filePatterns({ functionObject });

    // TODO(PARALLEL): Need to tune concurrency.
    // TODO: Is this the best way to do this?
    // TODO: Is this really 1 new thing in parallel?
    const worker = new Worker(require.resolve("./util/bundle"));
    const { numFiles, bundlePath } = await worker.globAndZip(
      { servicePath, base, roots, bundleName, include, exclude });

    this._logDebug(
      `Zipped ${numFiles} sources from ${servicePath} to artifact location: ${bundlePath}`
    );
  }

  async packageFunction({ functionName, functionObject }) {
    // Mimic built-in serverless naming.
    // **Note**: We _do_ append ".serverless" in path skipping serverless'
    // internal copying logic.
    const bundleName = path.join(SLS_TMP_DIR, `${functionName}.zip`);

    // Package.
    const start = new Date();
    this._logDebug(`Start packaging function: ${bundleName}`);
    await this.globAndZip({ bundleName, functionObject });

    // Mutate serverless configuration to use our artifacts.
    functionObject.package = functionObject.package || {};
    functionObject.package.artifact = bundleName;

    this._log(`Packaged function: ${bundleName} (${elapsed(start)}s)`);
  }

  async packageService() {
    const { service } = this.serverless;
    const serviceName = service.service;
    const servicePackage = service.package;

    // Mimic built-in serverless naming.
    const bundleName = path.join(SLS_TMP_DIR, `${serviceName}.zip`);

    // Package.
    const start = new Date();
    this._logDebug(`Start packaging service: ${bundleName}`);
    await this.globAndZip({ bundleName });

    // Mutate serverless configuration to use our artifacts.
    servicePackage.artifact = bundleName;

    this._log(`Packaged service: ${bundleName} (${elapsed(start)}s)`);
  }

  async package() {
    const { service } = this.serverless;
    const servicePackage = service.package;

    // Check if we have a single function limitation from `deploy -f name`.
    const singleFunctionName = (this.options || {}).function;
    if (singleFunctionName) {
      this._logDebug(`Packaging only for function: ${singleFunctionName}`);
    }

    // Gather internal configuration.
    const fnsPkgs = service.getAllFunctions()
      // Limit to single function if provided.
      .filter((functionName) => !singleFunctionName || singleFunctionName === functionName)
      // Convert to more useful format.
      .map((functionName) => ({
        functionName,
        functionObject: service.getFunction(functionName)
      }))
      .map((obj) => ({
        ...obj,
        functionPackage: obj.functionObject.package || {}
      }))
      .map((obj) => ({
        ...obj,
        disable: !!obj.functionPackage.disable,
        individually: !!obj.functionPackage.individually,
        artifact: obj.functionPackage.artifact
      }));

    // Get list of individual functions to package.
    const fnsPkgsToPackage = fnsPkgs.filter((obj) =>
      (servicePackage.individually || obj.individually) && !(obj.disable || obj.artifact)
    );

    // Process functions in serial.
    if (fnsPkgsToPackage.length) {
      this._log(`Packaging ${fnsPkgsToPackage.length} functions`);
      const limit = pLimit(1);
      await Promise.all(fnsPkgsToPackage.map((obj) => limit(() => this.packageFunction(obj))));
    }

    // We recreate the logic from `packager#packageService` for deciding whether
    // to package the service or not.
    const shouldPackageService = !servicePackage.individually
      && !servicePackage.artifact
      // Don't package service if we specify a single function **and** have a match
      && (!singleFunctionName || !fnsPkgsToPackage.length)
      // Otherwise, have some functions left that need to use the service package.
      && fnsPkgs.some((obj) => !(obj.disable || obj.individually || obj.artifact));

    // Package entire service if applicable.
    if (shouldPackageService) {
      await this.packageService();
    } else if (!fnsPkgsToPackage.length) {
      // Detect if we did nothing...
      this._logDebug("No matching service or functions to package.");
    }
  }
}

module.exports = Jetpack;
