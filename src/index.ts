import './polyfills';
import { resolve, extname, relative } from 'path';
import { chalk as colors, configLoader, lodash } from '@walrus/shared-utils';
import formatTime from 'pretty-ms';
import resolveFrom from 'resolve-from';
import { rollup, watch, Plugin as RollupPlugin, ModuleFormat as RollupFormat } from 'rollup';
import waterfall from 'p-waterfall';
import spinner from './spinner';
import logger from './logger';
import progressPlugin from './plugins/progress';
import nodeResolvePlugin from './plugins/node-resolve';
import isExternal from './utils/is-external';
import getBanner from './utils/get-banner';
import { getDefaultFileName, printAssets, Assets, getExistFile } from './utils';
import {
  Options,
  Config,
  NormalizedConfig,
  Format,
  ConfigEntryObject,
  Env,
  ConfigOutput,
  RunContext,
  RollupConfig,
  Task
} from './types';

// Make rollup-plugin-vue use basename in component.__file instead of absolute path
// TODO: PR to rollup-plugin-vue to allow this as an API option
process.env.BUILD = 'production';

interface RunOptions {
  write?: boolean;
  watch?: boolean;
  concurrent?: boolean;
}

interface RollupConfigInput {
  source: {
    input: string[] | ConfigEntryObject;
    files: string[];
    hasVue: boolean;
    hasTs: boolean;
  };
  title: string;
  format: Format;
  context: RunContext;
  assets: Assets;
  config: NormalizedConfig;
}

type PluginFactory = (opts: any) => RollupPlugin;
type GetPlugin = (name: string) => PluginFactory | Promise<PluginFactory>;

const merge = lodash.merge;

export class Bundler {
  rootDir: string;
  config: NormalizedConfig;
  configPath?: string;
  pkg: {
    path?: string;
    data?: any;
  };
  bundles: Set<Assets>;

  constructor(config: Config, public options: Options = {}) {
    logger.setOptions({ logLevel: options.logLevel });

    this.rootDir = resolve(options.rootDir || '.');

    this.pkg = configLoader.loadSync({
      files: ['package.json'],
      cwd: this.rootDir
    });
    if (!this.pkg.data) {
      this.pkg.data = {};
    }

    if (/\.mjs$/.test(this.pkg.data.module || this.pkg.data.main)) {
      logger.warn(`Pansy no longer use .mjs extension for esm bundle, you should use .js instead!`);
    }

    const userConfig =
      options.configFile === false
        ? {}
        : configLoader.loadSync({
            files:
              typeof options.configFile === 'string'
                ? [options.configFile]
                : [
                    'pansy.config.js',
                    'pansy.config.ts',
                    '.pansyrc.js',
                    '.pansyrc.ts',
                    'package.json'
                  ],
            cwd: this.rootDir,
            packageKey: 'pansy'
          });
    if (userConfig.path) {
      logger.debug(`Using config file:`, userConfig.path);
      this.configPath = userConfig.path;
    }

    this.config = this.normalizeConfig(config, userConfig.data || {}) as NormalizedConfig;

    this.bundles = new Set();
  }

  normalizeConfig = (config: Config, userConfig: Config) => {
    // 默认输入文件
    const entry = getExistFile({
      cwd: this.rootDir,
      files: ['src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js'],
      returnRelative: true
    });

    const result = merge({}, userConfig, config, {
      input: config.input || userConfig.input || entry || 'src/index.js',
      output: merge({}, userConfig.output, config.output),
      plugins: merge({}, userConfig.plugins, config.plugins),
      babel: merge(
        {
          asyncToPromises: true
        },
        userConfig.babel,
        config.babel
      ),
      externals: [
        ...(Array.isArray(userConfig.externals) ? userConfig.externals : [userConfig.externals]),
        ...(Array.isArray(config.externals) ? config.externals : [config.externals])
      ]
    });

    result.output.dir = resolve(result.output.dir || 'dist');

    return result;
  };

  async createRollupConfig({
    source,
    format,
    title,
    context,
    assets,
    config
  }: RollupConfigInput): Promise<RollupConfig> {
    // Always minify if config.minify is truthy
    // Otherwise infer by format
    const minify =
      config.output.minify === undefined ? format.endsWith('-min') : config.output.minify;
    let minPlaceholder = '';
    let rollupFormat: RollupFormat;
    if (format.endsWith('-min')) {
      rollupFormat = format.replace(/-min$/, '') as RollupFormat;
      minPlaceholder = '.min';
    } else {
      rollupFormat = format as RollupFormat;
    }

    // UMD format should always bundle node_modules
    const bundleNodeModules =
      rollupFormat === 'umd' || rollupFormat === 'iife' || config.bundleNodeModules;

    const pluginsOptions: { [key: string]: any } = {
      progress:
        config.plugins.progress !== false &&
        merge(
          {
            title
          },
          config.plugins.progress
        ),

      url: config.plugins.url !== false && merge({}, config.plugins.url),

      svgr: config.plugins.svgr !== false && merge({}, config.plugins.svgr),

      json: config.plugins.json !== false && merge({}, config.plugins.json),

      hashbang: config.plugins.hashbang !== false && merge({}, config.plugins.hashbang),

      'node-resolve':
        config.plugins['node-resolve'] !== false &&
        merge(
          {},
          {
            rootDir: this.rootDir,
            bundleNodeModules,
            externals: config.externals,
            browser: config.output.target === 'browser'
          },
          config.plugins['node-resolve']
        ),

      postcss:
        config.plugins.postcss !== false &&
        merge(
          {
            extract: config.output.extractCSS
          },
          config.plugins.postcss
        ),

      vue:
        (source.hasVue || config.plugins.vue) &&
        merge(
          {
            css: false
          },
          config.plugins.vue
        ),

      typescript2:
        (source.hasTs || config.plugins.typescript2) &&
        merge(
          {
            objectHashIgnoreUnknownHack: true,
            tsconfigOverride: {
              compilerOptions: {
                module: 'esnext'
              }
            }
          },
          config.plugins.typescript2
        ),

      babel:
        config.plugins.babel !== false &&
        merge(
          {
            exclude: 'node_modules/**',
            extensions: ['.js', '.jsx', '.mjs', '.ts', '.tsx', '.vue'],
            babelrc: config.babel.babelrc,
            configFile: config.babel.configFile,
            presetOptions: config.babel
          },
          config.plugins.babel
        ),

      buble:
        (config.plugins.buble || config.babel.minimal) &&
        merge(
          {
            exclude: 'node_modules/**',
            include: '**/*.{js,mjs,jsx,ts,tsx,vue}',
            transforms: {
              modules: false,
              dangerousForOf: true,
              dangerousTaggedTemplateString: true
            }
          },
          config.plugins.buble
        ),

      // 默认关闭，可手动开启 - 删除调试信息
      strip:
        config.plugins.strip &&
        merge(
          {
            functions: ['console.log']
          },
          config.plugins.strip
        ),

      alias:
        config.plugins.alias !== false &&
        merge(
          {
            entries: {
              '@': this.resolveRootDir('src')
            }
          },
          config.plugins.postcss
        ),

      commonjs:
        config.plugins.commonjs !== false &&
        merge({}, config.plugins.commonjs, {
          // `ignore` is required to allow dynamic require
          // See: https://github.com/rollup/rollup-plugin-commonjs/blob/4a22147456b1092dd565074dc33a63121675102a/src/index.js#L32
          ignore: (name: string) => {
            const { commonjs } = config.plugins;
            if (commonjs && commonjs.ignore && commonjs.ignore(name)) {
              return true;
            }
            return isExternal(config.externals, name);
          }
        })
    };

    const env = Object.assign({}, config.env);

    pluginsOptions.replace = {
      ...config.plugins.replace,
      values: {
        ...Object.keys(env).reduce((res: Env, name) => {
          res[`process.env.${name}`] = JSON.stringify(env[name]);
          return res;
        }, {}),
        ...(config.plugins.replace && config.plugins.replace.values)
      }
    };

    if (Object.keys(pluginsOptions.replace.values).length === 0) {
      pluginsOptions.replace = false;
    }

    const banner = getBanner(config.banner, this.pkg.data);

    if (minify) {
      const terserOptions = config.plugins.terser || {};
      pluginsOptions.terser = {
        ...terserOptions,
        output: {
          ...terserOptions.output,
          // Add banner (if there is)
          preamble: banner
        }
      };
    }

    for (const name of Object.keys(config.plugins)) {
      if (pluginsOptions[name] === undefined) {
        Object.assign(pluginsOptions, { [name]: config.plugins[name] });
      }
    }

    const getPlugin: GetPlugin = (name: string) => {
      if (config.resolvePlugins && config.resolvePlugins[name]) {
        return config.resolvePlugins[name];
      }

      // 是否是@rollup/plugin-*形式的内置包
      const isOfficialBuiltIn = require('../package').dependencies[`@rollup/plugin-${name}`];

      // 是否是rollup-plugin-*形式的内置包
      const isBuiltIn = require('../package').dependencies[`rollup-plugin-${name}`];

      const plugin =
        name === 'babel'
          ? import('./plugins/babel').then((res) => res.default)
          : name === 'node-resolve'
          ? nodeResolvePlugin
          : name === 'progress'
          ? progressPlugin
          : isOfficialBuiltIn
          ? require(`@rollup/plugin-${name}`)
          : isBuiltIn
          ? require(`rollup-plugin-${name}`)
          : name === 'svgr'
          ? require('@svgr/rollup')
          : this.localRequire(`rollup-plugin-${name}`);

      if (name === 'terser') {
        return plugin.terser;
      }

      return plugin.default || plugin;
    };

    const plugins = await Promise.all(
      Object.keys(pluginsOptions)
        .filter((name) => pluginsOptions[name])
        .map(async (name) => {
          const options = pluginsOptions[name] === true ? {} : pluginsOptions[name];
          const plugin = await getPlugin(name);
          return plugin(options);
        })
    );

    if (logger.isDebug) {
      for (const name of Object.keys(pluginsOptions)) {
        if (pluginsOptions[name]) {
          logger.debug(colors.dim(format), `Using plugin: ${name}`);
        }
      }
    }

    // Add bundle to out assets Map
    // So that we can log the stats when all builds completed
    // Make sure this is the last plugin!
    let startTime: number;
    let endTime: number;
    plugins.push({
      name: 'record-bundle',
      generateBundle(outputOptions, _assets) {
        const EXTS = [
          outputOptions.entryFileNames ? extname(outputOptions.entryFileNames) : '.js',
          '.css'
        ];
        for (const fileName of Object.keys(_assets)) {
          if (EXTS.some((ext) => fileName.endsWith(ext))) {
            const file: any = _assets[fileName];
            const absolute = outputOptions.dir && resolve(outputOptions.dir, fileName);
            if (absolute) {
              assets.set(relative(process.cwd(), absolute), {
                absolute,
                get source() {
                  return file.isAsset ? file.source.toString() : file.code;
                }
              });
            }
          }
        }
      },
      buildStart() {
        startTime = Date.now();
      },
      buildEnd() {
        endTime = Date.now();
      },
      async writeBundle() {
        await printAssets(
          assets,
          `${title.replace('Bundle', 'Bundled')} ${colors.dim(
            `(${formatTime(endTime - startTime)})`
          )}`
        );
      }
    });

    const defaultFileName = getDefaultFileName(rollupFormat);
    const getFileName = config.output.fileName || defaultFileName;
    const fileNameTemplate =
      typeof getFileName === 'function'
        ? getFileName({ format: rollupFormat, minify }, defaultFileName)
        : getFileName;
    const fileName = fileNameTemplate
      .replace(/\[min\]/, minPlaceholder)
      // The `[ext]` placeholder no longer makes sense
      // Since we only output to `.js` now
      // Probably remove it in the future
      .replace(/\[ext\]/, '.js');

    return {
      inputConfig: {
        input: source.input,
        plugins,
        external: Object.keys(config.globals || {}).filter((v) => !/^[\.\/]/.test(v)),
        onwarn(warning) {
          if (typeof warning === 'string') {
            return logger.warn(warning);
          }
          const code = (warning.code || '').toLowerCase();
          if (code === 'mixed_exports' || code === 'missing_global_name') {
            return;
          }
          let message = warning.message;
          if (code === 'unresolved_import' && warning.source) {
            if (format !== 'umd' || context.unresolved.has(warning.source)) {
              return;
            }
            context.unresolved.add(warning.source);
            message = `${warning.source} is treated as external dependency`;
          }
          logger.warn(`${colors.yellow(`${code}`)}${colors.dim(':')} ${message}`);
        }
      },
      outputConfig: {
        globals: config.globals,
        format: rollupFormat,
        dir: resolve(config.output.dir || 'dist'),
        entryFileNames: fileName,
        name: config.output.moduleName,
        banner,
        sourcemap: typeof config.output.sourceMap === 'boolean' ? config.output.sourceMap : minify,
        sourcemapExcludeSources: config.output.sourceMapExcludeSources
      }
    };
  }

  async run(options: RunOptions = {}) {
    const context: RunContext = {
      unresolved: new Set()
    };
    const tasks: Task[] = [];

    let { input } = this.config;

    if (!Array.isArray(input)) {
      input = [input || 'src/index.js'];
    }
    if (Array.isArray(input) && input.length === 0) {
      input = ['src/index.js'];
    }

    const getMeta = (files: string[]) => {
      return {
        hasVue: files.some((file) => file.endsWith('.vue')),
        hasTs: files.some((file) => /\.tsx?$/.test(file))
      };
    };

    const normalizeInputValue = (input: string[] | ConfigEntryObject) => {
      if (Array.isArray(input)) {
        return input.map((v) => `./${relative(this.rootDir, this.resolveRootDir(v))}`);
      }
      return Object.keys(input).reduce((res: ConfigEntryObject, entryName: string) => {
        res[entryName] = `./${relative(this.rootDir, this.resolveRootDir(input[entryName]))}`;
        return res;
      }, {});
    };

    const sources = input.map((v) => {
      if (typeof v === 'string') {
        const files = v.split(',');
        return {
          files,
          input: normalizeInputValue(files),
          ...getMeta(files)
        };
      }
      const files = Object.values(v);
      return {
        files,
        input: normalizeInputValue(v),
        ...getMeta(files)
      };
    });

    let { format, target } = this.config.output;
    if (Array.isArray(format)) {
      if (format.length === 0) {
        format = ['cjs'];
      }
    } else if (typeof format === 'string') {
      format = format.split(',') as Format[];
    } else {
      format = ['cjs'];
    }
    const formats = format;

    for (const source of sources) {
      for (const format of formats) {
        let title = `Bundle ${source.files.join(', ')} in ${format} format`;
        if (target) {
          title += ` for target ${target}`;
        }
        tasks.push({
          title,
          getConfig: async (context, task) => {
            const assets: Assets = new Map();
            this.bundles.add(assets);
            const config = this.config.extendConfig
              ? this.config.extendConfig(merge({}, this.config), {
                  input: source.input,
                  format
                })
              : this.config;
            const rollupConfig = await this.createRollupConfig({
              source,
              format,
              title: task.title,
              context,
              assets,
              config
            });
            return this.config.extendRollupConfig
              ? this.config.extendRollupConfig(rollupConfig)
              : rollupConfig;
          }
        });
      }
    }

    if (options.watch) {
      const configs = await Promise.all(
        tasks.map(async (task) => {
          const { inputConfig, outputConfig } = await task.getConfig(context, task);
          return {
            ...inputConfig,
            output: outputConfig,
            watch: {}
          };
        })
      );
      const watcher = watch(configs);
      watcher.on('event', (e) => {
        if (e.code === 'ERROR') {
          logger.error(e.error.message);
        }
      });
    } else {
      try {
        if (options.concurrent) {
          await Promise.all(
            tasks.map((task) => {
              return this.build(task, context, options.write);
            })
          );
        } else {
          await waterfall(
            tasks.map((task) => () => {
              return this.build(task, context, options.write);
            }),
            context
          );
        }
      } catch (err) {
        spinner.stop();
        throw err;
      }
    }

    return this;
  }

  async build(task: Task, context: RunContext, write?: boolean) {
    try {
      const { inputConfig, outputConfig } = await task.getConfig(context, task);
      const bundle = await rollup(inputConfig);
      if (write) {
        await bundle.write(outputConfig);
      } else {
        await bundle.generate(outputConfig);
      }
    } catch (err) {
      err.rollup = true;
      logger.error(task.title.replace('Bundle', 'Failed to bundle'));
      if (err.message.includes('You must supply output.name for UMD bundles')) {
        err.code = 'require_module_name';
        err.message = `You must supply output.moduleName option or use --module-name <name> flag for UMD bundles`;
      }
      throw err;
    }
  }

  handleError = (err: any) => {
    if (err.stack) {
      console.error();
      console.error(colors.bold(colors.red('Stack Trace:')));
      console.error(colors.dim(err.stack));
    }
  };

  resolveRootDir = (...args: string[]) => {
    return resolve(this.rootDir, ...args);
  };

  localRequire(name: string, { silent, cwd }: { silent?: boolean; cwd?: string } = {}) {
    cwd = cwd || this.rootDir;
    const resolved = silent ? resolveFrom.silent(cwd, name) : resolveFrom(cwd, name);
    return resolved && require(resolved);
  }

  getBundle(index: number) {
    return [...this.bundles][index];
  }
}

export { Config, NormalizedConfig, Options, ConfigOutput };
