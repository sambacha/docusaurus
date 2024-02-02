/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'fs-extra';
import path from 'path';
import _ from 'lodash';
import logger from '@docusaurus/logger';
import {DOCUSAURUS_VERSION, mapAsyncSequential} from '@docusaurus/utils';
import {load, loadContext, type LoadContextOptions} from '../server';
import {handleBrokenLinks} from '../server/brokenLinks';

import {createBuildClientConfig} from '../webpack/client';
import createServerConfig from '../webpack/server';
import {
  executePluginsConfigurePostCss,
  executePluginsConfigureWebpack,
  compile,
} from '../webpack/utils';
import {loadI18n} from '../server/i18n';
import {generateStaticFiles} from '../ssg';
import ssrDefaultTemplate from '../webpack/templates/ssr.html.template';
import type {Manifest} from 'react-loadable-ssr-addon-v5-slorber';
import type {LoadedPlugin, Props} from '@docusaurus/types';
import type {SiteCollectedData} from '../types';

// For now this is a private env variable we use internally
// But we'll want to expose this feature officially some day
const isPerfLogging = !!process.env.DOCUSAURUS_PERF_LOGGER;
isPerfLogging &&
  console.log('[PERF] Docusaurus build performance logging enable');

export type BuildCLIOptions = Pick<
  LoadContextOptions,
  'config' | 'locale' | 'outDir'
> & {
  bundleAnalyzer?: boolean;
  minify?: boolean;
  dev?: boolean;
};

export async function build(
  siteDirParam: string = '.',
  cliOptions: Partial<BuildCLIOptions> = {},
  // When running build, we force terminate the process to prevent async
  // operations from never returning. However, if run as part of docusaurus
  // deploy, we have to let deploy finish.
  // See https://github.com/facebook/docusaurus/pull/2496
  forceTerminate: boolean = true,
): Promise<void> {
  process.env.BABEL_ENV = 'production';
  process.env.NODE_ENV = 'production';
  process.env.DOCUSAURUS_CURRENT_LOCALE = cliOptions.locale;
  if (cliOptions.dev) {
    logger.info`Building in dev mode`;
    process.env.BABEL_ENV = 'development';
    process.env.NODE_ENV = 'development';
  }

  const siteDir = await fs.realpath(siteDirParam);

  ['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => process.exit());
  });

  async function tryToBuildLocale({
    locale,
    isLastLocale,
  }: {
    locale: string;
    isLastLocale: boolean;
  }) {
    try {
      isPerfLogging &&
        console.time(`[PERF] Building site for locale ${locale}`);
      await buildLocale({
        siteDir,
        locale,
        cliOptions,
        forceTerminate,
        isLastLocale,
      });
      isPerfLogging &&
        console.timeEnd(`[PERF] Building site for locale ${locale}`);
    } catch (err) {
      throw new Error(
        logger.interpolate`Unable to build website for locale name=${locale}.`,
        {
          cause: err,
        },
      );
    }
  }

  isPerfLogging && console.time(`[PERF] Get locales to build`);
  const locales = await getLocalesToBuild({siteDir, cliOptions});
  isPerfLogging && console.timeEnd(`[PERF] Get locales to build`);

  if (locales.length > 1) {
    logger.info`Website will be built for all these locales: ${locales}`;
  }

  isPerfLogging && console.time(`[PERF] Building ${locales.length} locales`);
  await mapAsyncSequential(locales, (locale) => {
    const isLastLocale = locales.indexOf(locale) === locales.length - 1;
    return tryToBuildLocale({locale, isLastLocale});
  });
  isPerfLogging && console.timeEnd(`[PERF] Building ${locales.length} locales`);
}

async function getLocalesToBuild({
  siteDir,
  cliOptions,
}: {
  siteDir: string;
  cliOptions: BuildCLIOptions;
}): Promise<[string, ...string[]]> {
  if (cliOptions.locale) {
    return [cliOptions.locale];
  }

  const context = await loadContext({
    siteDir,
    outDir: cliOptions.outDir,
    config: cliOptions.config,
    locale: cliOptions.locale,
    localizePath: cliOptions.locale ? false : undefined,
  });
  const i18n = await loadI18n(context.siteConfig, {
    locale: cliOptions.locale,
  });
  if (i18n.locales.length > 1) {
    logger.info`Website will be built for all these locales: ${i18n.locales}`;
  }

  // We need the default locale to always be the 1st in the list. If we build it
  // last, it would "erase" the localized sites built in sub-folders
  return [
    i18n.defaultLocale,
    ...i18n.locales.filter((locale) => locale !== i18n.defaultLocale),
  ];
}

async function buildLocale({
  siteDir,
  locale,
  cliOptions,
  forceTerminate,
  isLastLocale,
}: {
  siteDir: string;
  locale: string;
  cliOptions: Partial<BuildCLIOptions>;
  forceTerminate: boolean;
  isLastLocale: boolean;
}): Promise<string> {
  // Temporary workaround to unlock the ability to translate the site config
  // We'll remove it if a better official API can be designed
  // See https://github.com/facebook/docusaurus/issues/4542
  process.env.DOCUSAURUS_CURRENT_LOCALE = locale;

  logger.info`name=${`[${locale}]`} Creating an optimized production build...`;

  isPerfLogging && console.time('[PERF] Loading site');
  const props: Props = await load({
    siteDir,
    outDir: cliOptions.outDir,
    config: cliOptions.config,
    locale,
    localizePath: cliOptions.locale ? false : undefined,
  });
  isPerfLogging && console.timeEnd('[PERF] Loading site');

  // Apply user webpack config.
  const {outDir, plugins} = props;

  // We can build the 2 configs in parallel
  isPerfLogging && console.time('[PERF] Creating webpack configs');
  const [{clientConfig, clientManifestPath}, {serverConfig, serverBundlePath}] =
    await Promise.all([
      buildPluginsClientConfig({
        plugins,
        props,
        minify: cliOptions.minify ?? true,
        bundleAnalyzer: cliOptions.bundleAnalyzer ?? false,
      }),
      buildPluginsServerConfig({
        plugins,
        props,
      }),
    ]);
  isPerfLogging && console.timeEnd('[PERF] Creating webpack configs');

  // TODO do we really need this? .docusaurus folder is cleaned between builds
  // Make sure generated client-manifest is cleaned first, so we don't reuse
  // the one from previous builds.
  isPerfLogging && console.time('[PERF] Deleting previous client manifest');
  if (await fs.pathExists(clientManifestPath)) {
    await fs.unlink(clientManifestPath);
  }
  isPerfLogging && console.timeEnd('[PERF] Deleting previous client manifest');

  // Run webpack to build JS bundle (client) and static html files (server).
  isPerfLogging && console.time('[PERF] Bundling');
  await compile([clientConfig, serverConfig]);
  isPerfLogging && console.timeEnd('[PERF] Bundling');

  isPerfLogging && console.time('[PERF] Reading client manifest');
  const manifest: Manifest = await fs.readJSON(clientManifestPath, 'utf-8');
  isPerfLogging && console.timeEnd('[PERF] Reading client manifest');

  isPerfLogging && console.time('[PERF] Executing static site generation');
  const {collectedData} = await handleSSG({
    props,
    serverBundlePath,
    manifest,
  });
  isPerfLogging && console.timeEnd('[PERF] Executing static site generation');

  // Remove server.bundle.js because it is not needed.
  isPerfLogging && console.time('[PERF] Deleting server bundle');
  if (await fs.pathExists(serverBundlePath)) {
    await fs.unlink(serverBundlePath);
  }
  isPerfLogging && console.timeEnd('[PERF] Deleting server bundle');

  // Plugin Lifecycle - postBuild.
  isPerfLogging && console.time('[PERF] Executing postBuild()');
  await executePluginsPostBuild({plugins, props, collectedData});
  isPerfLogging && console.timeEnd('[PERF] Executing postBuild()');

  // TODO execute this in parallel to postBuild?
  isPerfLogging && console.time('[PERF] Executing broken links checker');
  await executeBrokenLinksCheck({props, collectedData});
  isPerfLogging && console.timeEnd('[PERF] Executing broken links checker');

  logger.success`Generated static files in path=${path.relative(
    process.cwd(),
    outDir,
  )}.`;

  if (isLastLocale) {
    logger.info`Use code=${'npm run serve'} command to test your build locally.`;
  }

  if (forceTerminate && isLastLocale && !cliOptions.bundleAnalyzer) {
    process.exit(0);
  }

  return outDir;
}

// TODO refactor
async function handleSSG({
  props,
  serverBundlePath,
  manifest,
}: {
  props: Props;
  serverBundlePath: string;
  manifest: Manifest;
}) {
  return generateStaticFiles({
    pathnames: props.routesPaths,
    serverBundlePath,
    serverEntryParams: {
      trailingSlash: props.siteConfig.trailingSlash,
      outDir: props.outDir,
      baseUrl: props.baseUrl,
      manifest,
      headTags: props.headTags,
      preBodyTags: props.preBodyTags,
      postBodyTags: props.postBodyTags,
      ssrTemplate: props.siteConfig.ssrTemplate ?? ssrDefaultTemplate,
      noIndex: props.siteConfig.noIndex,
      DOCUSAURUS_VERSION,
    },
  });
}

async function executePluginsPostBuild({
  plugins,
  props,
  collectedData,
}: {
  plugins: LoadedPlugin[];
  props: Props;
  collectedData: SiteCollectedData;
}) {
  const head = _.mapValues(collectedData, (d) => d.headTags);
  await Promise.all(
    plugins.map(async (plugin) => {
      if (!plugin.postBuild) {
        return;
      }
      await plugin.postBuild({
        ...props,
        head,
        content: plugin.content,
      });
    }),
  );
}

async function executeBrokenLinksCheck({
  props: {
    routes,
    siteConfig: {onBrokenLinks, onBrokenAnchors},
  },
  collectedData,
}: {
  props: Props;
  collectedData: SiteCollectedData;
}) {
  const collectedLinks = _.mapValues(collectedData, (d) => ({
    links: d.links,
    anchors: d.anchors,
  }));
  await handleBrokenLinks({
    collectedLinks,
    routes,
    onBrokenLinks,
    onBrokenAnchors,
  });
}

async function buildPluginsClientConfig({
  plugins,
  props,
  minify,
  bundleAnalyzer,
}: {
  plugins: LoadedPlugin[];
  props: Props;
  minify: boolean;
  bundleAnalyzer: boolean;
}) {
  const result = await createBuildClientConfig({
    props,
    minify,
    bundleAnalyzer,
  });
  let {config} = result;
  config = executePluginsConfigureWebpack({
    plugins,
    config,
    isServer: false,
    jsLoader: props.siteConfig.webpack?.jsLoader,
  });
  return {clientConfig: config, clientManifestPath: result.clientManifestPath};
}

async function buildPluginsServerConfig({
  plugins,
  props,
}: {
  plugins: LoadedPlugin[];
  props: Props;
}) {
  const result = await createServerConfig({
    props,
  });
  let {config} = result;
  config = executePluginsConfigurePostCss({
    plugins,
    config,
  });
  config = executePluginsConfigureWebpack({
    plugins,
    config,
    isServer: true,
    jsLoader: props.siteConfig.webpack?.jsLoader,
  });
  return {serverConfig: config, serverBundlePath: result.serverBundlePath};
}
