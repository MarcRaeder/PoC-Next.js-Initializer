import { install } from '../helpers/install';
import { makeDir } from '../helpers/make-dir';

import cpy from 'cpy';
import globOrig from 'glob';
import os from 'os';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import util from 'util';
import { Sema } from 'async-sema';

import { GetTemplateFileArgs, InstallTemplateArgs } from './types';

const glob = util.promisify(globOrig);

/**
 * Get the file path for a given file in a template, e.g. "next.config.js".
 */
export const getTemplateFile = ({ template, mode, file }: GetTemplateFileArgs): string => {
  return path.join(__dirname, template, mode, file);
};

export const SRC_DIR_NAMES = ['app', 'pages', 'styles'];

/**
 * Install a Next.js internal template to a given `root` directory.
 */
export const installTemplate = async ({
  appName,
  root,
  packageManager,
  isOnline,
  template,
  mode,
  tailwind,
  eslint,
  srcDir,
  importAlias,
  authority,
  engine,
}: InstallTemplateArgs) => {
  console.log(chalk.bold(`Using ${packageManager}.`));

  /**
   * Copy the template files to the target directory.
   */
  console.log('\nInitializing project with template:', template, '\n');
  const templatePath = path.join(__dirname, template, mode);
  console.log('temolatepath', templatePath);
  const copySource = ['**'];
  if (!eslint) copySource.push('!eslintrc.json');
  if (!tailwind) copySource.push('!tailwind.config.js', '!postcss.config.js');

  await cpy(copySource, root, {
    parents: true,
    cwd: templatePath,
    rename: (name) => {
      switch (name) {
        case 'gitignore':
        case 'eslintrc.json': {
          return '.'.concat(name);
        }
        // README.md is ignored by webpack-asset-relocator-loader used by ncc:
        // https://github.com/vercel/webpack-asset-relocator-loader/blob/e9308683d47ff507253e37c9bcbb99474603192b/src/asset-relocator.js#L227
        case 'README-template.md': {
          return 'README.md';
        }
        default: {
          return name;
        }
      }
    },
  });

  const tsconfigFile = path.join(root, mode === 'js' ? 'jsconfig.json' : 'tsconfig.json');
  await fs.promises.writeFile(
    tsconfigFile,
    (await fs.promises.readFile(tsconfigFile, 'utf8'))
      .replace(`"@/*": ["./*"]`, srcDir ? `"@/*": ["./src/*"]` : `"@/*": ["./*"]`)
      .replace(`"@/*":`, `"${importAlias}":`)
  );

  // update import alias in any files if not using the default
  if (importAlias !== '@/*') {
    const files = await glob('**/*', { cwd: root, dot: true });
    const writeSema = new Sema(8, { capacity: files.length });
    await Promise.all(
      files.map(async (file) => {
        // We don't want to modify compiler options in [ts/js]config.json
        if (file === 'tsconfig.json' || file === 'jsconfig.json') return;
        await writeSema.acquire();
        const filePath = path.join(root, file);
        if ((await fs.promises.stat(filePath)).isFile()) {
          await fs.promises.writeFile(
            filePath,
            (await fs.promises.readFile(filePath, 'utf8')).replace(`@/`, `${importAlias.replace(/\*/g, '')}`)
          );
        }
        await writeSema.release();
      })
    );
  }

  const isAppTemplate = template.startsWith('app');

  if (srcDir) {
    await makeDir(path.join(root, 'src'));
    await Promise.all(
      SRC_DIR_NAMES.map(async (file) => {
        await fs.promises.rename(path.join(root, file), path.join(root, 'src', file)).catch((err) => {
          if (err.code !== 'ENOENT') {
            throw err;
          }
        });
      })
    );

    // Change the `Get started by editing pages/index` / `app/page` to include `src`
    const indexPageFile = path.join(
      'src',
      isAppTemplate ? 'app' : 'pages',
      `${isAppTemplate ? 'page' : 'index'}.${mode === 'ts' ? 'tsx' : 'js'}`
    );

    await fs.promises.writeFile(
      indexPageFile,
      (
        await fs.promises.readFile(indexPageFile, 'utf8')
      ).replace(isAppTemplate ? 'app/page' : 'pages/index', isAppTemplate ? 'src/app/page' : 'src/pages/index')
    );

    if (tailwind) {
      const tailwindConfigFile = path.join(root, 'tailwind.config.js');
      await fs.promises.writeFile(
        tailwindConfigFile,
        (
          await fs.promises.readFile(tailwindConfigFile, 'utf8')
        ).replace(/\.\/(\w+)\/\*\*\/\*\.\{js,ts,jsx,tsx,mdx\}/g, './src/$1/**/*.{js,ts,jsx,tsx,mdx}')
      );
    }
  }

  if (authority) {
    /**
     * the path depends on whether the user wants a src and/or app directory
     */
    const destinationPathSegments = [root];
    if (srcDir) {
      destinationPathSegments.push('src');
    }

    if (isAppTemplate) {
      destinationPathSegments.push('app');
    }

    const nextAuthPath = path.join(...destinationPathSegments, 'api', 'auth', '[...nextauth]');
    const dockerComposeFilePath = path.join(root, 'docker-compose.yml');
    await makeDir(nextAuthPath);
    await fs.promises.writeFile(
      dockerComposeFilePath,
      await fs.promises.readFile(path.join(__dirname, 'authority', 'docker-compose.yml'))
    );
    const middlewareFilePath = path.join(root, 'middleware.tsx');
    await fs.promises.writeFile(
      middlewareFilePath,
      await fs.promises.readFile(path.join(__dirname, 'authority', 'middleware.tsx'))
    );
    const envFilePath = path.join(root, '.env');
    await fs.promises.appendFile(
      envFilePath,
      await fs.promises.readFile(path.join(__dirname, 'authority', '.env'))
    );
    const routeFilePath = path.join(nextAuthPath, 'route.ts');
    await fs.promises.writeFile(
      routeFilePath,
      await fs.promises.readFile(path.join(__dirname, 'authority', 'route.ts'))
    );
    const processcubePath = path.join(root, '.processcube');
    await makeDir(processcubePath);
    const authorityPath = path.join(processcubePath, 'authority');
    await makeDir(authorityPath);
    const configFilePath = path.join(authorityPath, 'config.json');

    if (!engine) {
    const configFile = await fs.promises.readFile(path.join(__dirname, 'authority', 'config.json'), 'utf-8');
    const configObject = JSON.parse(configFile);
    delete configObject.engines;
    const newConfigFile = JSON.stringify(configObject, null, 2);
    await fs.promises.writeFile(
      configFilePath,
      newConfigFile
    );
    } else {
      await fs.promises.writeFile(
        configFilePath,
        await fs.promises.readFile(path.join(__dirname, 'authority', 'config.json'), 'utf-8')
      );
    }
    const usersFilePath = path.join(authorityPath, 'users.json');
    await fs.promises.writeFile(
      usersFilePath,
      await fs.promises.readFile(path.join(__dirname, 'authority', 'users.json'))
    );
  }

  if (engine) {
    /**
     * the path depends on whether the user wants a src and/or app directory
     */
    const destinationPathSegments = [root];
    if (srcDir) {
      destinationPathSegments.push('src');
    }

    if (isAppTemplate) {
      destinationPathSegments.push('app');
    }

    const dockerComposeFilePath = path.join(root, 'docker-compose.yml');
    const processcubePath = path.join(root, '.processcube');
    await makeDir(processcubePath);
    const enginePath = path.join(processcubePath, 'engine/config');
    await makeDir(enginePath);
    const configFilePath = path.join(enginePath, 'config.json');
    

    if(authority) {
      await fs.readFile(path.join(__dirname, 'engine', 'docker-compose.yml'), 'utf8', async (err, data) => {
        if (err) {
          console.error('Error reading the file:', err);
          return;
        }  
        const lines = data.split('\n').slice(2);
        const modifiedContent = lines.join('\n');
        await fs.promises.appendFile(dockerComposeFilePath, modifiedContent);
      });
      await fs.promises.writeFile(
        configFilePath,
        await fs.promises.readFile(path.join(__dirname, 'engine', 'config.json'), 'utf-8')
      );
    } else {
      await fs.promises.writeFile(
        dockerComposeFilePath,
        await fs.promises.readFile(path.join(__dirname, 'engine', 'docker-compose.yml'))
      );
      const configFile = await fs.promises.readFile(path.join(__dirname, 'engine', 'config.json'), 'utf-8');
      const configObject = JSON.parse(configFile);
      delete configObject.iam;
      const newConfigFile = JSON.stringify(configObject, null, 2);
      await fs.promises.writeFile(
        configFilePath,
        newConfigFile)
      ;}
    const envFilePath = path.join(root, '.env');
    await fs.promises.appendFile(
      envFilePath,
      await fs.promises.readFile(path.join(__dirname, 'engine', '.env'))
    );
    }
  /**
   * Create a package.json for the new project.
   */
  const packageJson = {
    name: appName,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint',
    },
  };

  /**
   * Write it to disk.
   */
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2) + os.EOL);

  /**
   * These flags will be passed to `install()`, which calls the package manager
   * install process.
   */
  const installFlags = { packageManager, isOnline };

  /**
   * Default dependencies.
   */
  const dependencies = [
    'react',
    'react-dom',
    `next${process.env.NEXT_PRIVATE_TEST_VERSION ? `@${process.env.NEXT_PRIVATE_TEST_VERSION}` : ''}`,
    '@5minds/processcube_app_sdk@^0.0.1-develop-e5b363-lki8hmms',
  ];

  /**
   * TypeScript projects will have type definitions and other devDependencies.
   */
  if (mode === 'ts') {
    dependencies.push('typescript', '@types/react', '@types/node', '@types/react-dom');
  }

  /**
   * Add Tailwind CSS dependencies.
   */
  if (tailwind) {
    dependencies.push('tailwindcss', 'postcss', 'autoprefixer');
  }

  if (authority) {
    dependencies.push('next-auth');
  }

  /**
   * Default eslint dependencies.
   */
  if (eslint) {
    dependencies.push('eslint', 'eslint-config-next');
  }
  /**
   * Install package.json dependencies if they exist.
   */
  if (dependencies.length) {
    console.log();
    console.log('Installing dependencies:');
    for (const dependency of dependencies) {
      console.log(`- ${chalk.cyan(dependency)}`);
    }
    console.log();

    await install(root, dependencies, installFlags);
  }
};

export * from './types';
