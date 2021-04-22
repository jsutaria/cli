const { EOL } = require('os')
const path = require('path')
const process = require('process')

const { listFrameworks, hasFramework, getFramework } = require('@netlify/framework-info')
const chalk = require('chalk')
const fuzzy = require('fuzzy')
const getPort = require('get-port')
const inquirer = require('inquirer')
const inquirerAutocompletePrompt = require('inquirer-autocomplete-prompt')
const isPlainObject = require('is-plain-obj')

const { readFileAsyncCatchError } = require('../lib/fs')

const { NETLIFYDEVLOG, NETLIFYDEVWARN } = require('./logo')

const readHttpsSettings = async (options) => {
  if (!isPlainObject(options)) {
    throw new TypeError(`https options should be an object with 'keyFile' and 'certFile' string properties`)
  }

  const { keyFile, certFile } = options
  if (typeof keyFile !== 'string') {
    throw new TypeError(`Private key file configuration should be a string`)
  }
  if (typeof certFile !== 'string') {
    throw new TypeError(`Certificate file configuration should be a string`)
  }

  const [{ content: key, error: keyError }, { content: cert, error: certError }] = await Promise.all([
    readFileAsyncCatchError(keyFile),
    readFileAsyncCatchError(certFile),
  ])

  if (keyError) {
    throw new Error(`Error reading private key file: ${keyError.message}`)
  }
  if (certError) {
    throw new Error(`Error reading certificate file: ${certError.message}`)
  }

  return { key, cert }
}

const validateStringProperty = ({ devConfig, property }) => {
  if (devConfig[property] && typeof devConfig[property] !== 'string') {
    throw new TypeError(
      `Invalid "${property}" option provided in config. The value of "${property}" option must be a string`,
    )
  }
}

const validateNumberProperty = ({ devConfig, property }) => {
  if (devConfig[property] && typeof devConfig[property] !== 'number') {
    throw new TypeError(
      `Invalid "${property}" option provided in config. The value of "${property}" option must be an integer`,
    )
  }
}

const validateFrameworkConfig = ({ devConfig }) => {
  validateStringProperty({ devConfig, property: 'command' })
  validateNumberProperty({ devConfig, property: 'port' })
  validateNumberProperty({ devConfig, property: 'targetPort' })

  if (devConfig.targetPort && devConfig.targetPort === devConfig.port) {
    throw new Error(
      '"port" and "targetPort" options cannot have same values. Please consult the documentation for more details: https://cli.netlify.com/netlify-dev#netlifytoml-dev-block',
    )
  }
}

const validateConfiguredPort = ({ devConfig, detectedPort }) => {
  if (devConfig.port && devConfig.port === detectedPort) {
    throw new Error(
      'The "port" option you specified conflicts with the port of your application. Please use a different value for "port"',
    )
  }
}

const DEFAULT_PORT = 8888
const DEFAULT_STATIC_PORT = 3999

const getDefaultDist = ({ log }) => {
  log(`${NETLIFYDEVLOG} Using current working directory`)
  log(`${NETLIFYDEVWARN} Unable to determine public folder to serve files from`)
  log(`${NETLIFYDEVWARN} Setup a netlify.toml file with a [dev] section to specify your dev server settings.`)
  log(`${NETLIFYDEVWARN} See docs at: https://cli.netlify.com/netlify-dev#project-detection`)
  return process.cwd()
}

const acquirePort = async ({ configuredPort, defaultPort, errorMessage }) => {
  const acquiredPort = await getPort({ port: configuredPort || defaultPort })
  if (configuredPort && acquiredPort !== configuredPort) {
    throw new Error(`${errorMessage}: '${configuredPort}'`)
  }
  return acquiredPort
}

const handleStaticServer = async ({ flags, log, devConfig, projectDir }) => {
  validateNumberProperty({ devConfig, property: 'staticServerPort' })

  if (flags.dir) {
    log(`${NETLIFYDEVWARN} Using simple static server because --dir flag was specified`)
  } else if (devConfig.framework === '#static') {
    log(`${NETLIFYDEVWARN} Using simple static server because [dev.framework] was set to #static`)
  }

  if (devConfig.command) {
    log(`${NETLIFYDEVWARN} Ignoring command setting since using a simple static server`)
  }

  if (devConfig.targetPort) {
    log(
      `${NETLIFYDEVWARN} Ignoring targetPort setting since using a simple static server.${EOL}Use --staticServerPort or [dev.staticServerPort] to configure the static server port`,
    )
  }

  const dist = flags.dir || devConfig.publish || getDefaultDist({ log })
  log(`${NETLIFYDEVWARN} Running static server from "${path.relative(path.dirname(projectDir), dist)}"`)

  const frameworkPort = await acquirePort({
    configuredPort: devConfig.staticServerPort,
    defaultPort: DEFAULT_STATIC_PORT,
    errorMessage: 'Could not acquire configured static server port',
  })
  return {
    useStaticServer: true,
    frameworkPort,
    dist,
  }
}

const getSettingsFromFramework = (framework) => {
  const {
    build: { directory: dist },
    dev: {
      commands: [command],
      port: frameworkPort,
      pollingStrategies,
    },
    name: frameworkName,
    staticAssetsDirectory: staticDir,
    env,
  } = framework

  return {
    command,
    frameworkPort,
    dist: staticDir || dist,
    framework: frameworkName,
    env,
    pollingStrategies: pollingStrategies.map(({ name }) => name),
  }
}

const detectFrameworkSettings = async ({ projectDir, log }) => {
  const frameworks = await listFrameworks({ projectDir })

  if (frameworks.length === 1) {
    return getSettingsFromFramework(frameworks[0])
  }

  if (frameworks.length > 1) {
    /** multiple matching detectors, make the user choose */
    inquirer.registerPrompt('autocomplete', inquirerAutocompletePrompt)
    const scriptInquirerOptions = formatSettingsArrForInquirer(frameworks)
    const { chosenFramework } = await inquirer.prompt({
      name: 'chosenFramework',
      message: `Multiple possible start commands found`,
      type: 'autocomplete',
      source(_, input) {
        if (!input || input === '') {
          return scriptInquirerOptions
        }
        // only show filtered results
        return filterSettings(scriptInquirerOptions, input)
      },
    })
    log(
      `Add \`framework = "${chosenFramework.name}"\` to [dev] section of your netlify.toml to avoid this selection prompt next time`,
    )

    return getSettingsFromFramework(chosenFramework)
  }
}

const hasCommandAndTargetPort = ({ devConfig }) => devConfig.command && devConfig.targetPort

const handleCustomFramework = ({ devConfig, log }) => {
  if (!hasCommandAndTargetPort({ devConfig })) {
    throw new Error('"command" and "targetPort" properties are required when "framework" is set to "#custom"')
  }
  return {
    command: devConfig.command,
    frameworkPort: devConfig.targetPort,
    dist: devConfig.publish || getDefaultDist({ log }),
    framework: '#custom',
  }
}

const handleForcedFramework = async ({ devConfig, projectDir }) => {
  try {
    const hasConfigFramework = await hasFramework(devConfig.framework, { projectDir })
    if (!hasConfigFramework) {
      throw new Error(`Specified "framework" "${devConfig.framework}" did not pass requirements for your project`)
    }
  } catch (error) {
    // this can happen when the framework info library doesn't support detecting devConfig.framework
    throw new Error(
      `Unsupported "framework" "${devConfig.framework}". Please consult the documentation for more details: https://cli.netlify.com/netlify-dev/#project-detection`,
    )
  }
  const { command, frameworkPort, dist, framework, env, pollingStrategies } = getSettingsFromFramework(
    await getFramework(devConfig.framework, { projectDir }),
  )
  return {
    command: devConfig.command || command,
    frameworkPort: devConfig.targetPort || frameworkPort,
    dist: devConfig.publish || dist,
    framework,
    env,
    pollingStrategies,
  }
}

const detectServerSettings = async (devConfig, flags, projectDir, log) => {
  validateStringProperty({ devConfig, property: 'framework' })

  let settings = {}

  if (flags.dir || devConfig.framework === '#static') {
    // serving files statically without a framework server
    settings = await handleStaticServer({ flags, log, devConfig, projectDir })
  } else if (devConfig.framework === '#auto') {
    // this is the default CLI behavior
    const frameworkSettings = await detectFrameworkSettings({ projectDir, log })
    if (frameworkSettings === undefined && !hasCommandAndTargetPort({ devConfig })) {
      log(
        `${NETLIFYDEVWARN} No app server detected and no "command" and "targetPort" specified. Using simple static server. Please consult the documentation for more details: https://cli.netlify.com/netlify-dev/#project-detection`,
      )
      settings = await handleStaticServer({ flags, log, devConfig, projectDir })
    } else {
      validateFrameworkConfig({ devConfig })
      const { command, frameworkPort, dist, framework, env, pollingStrategies } = frameworkSettings || {}
      settings = {
        command: devConfig.command || command,
        frameworkPort: devConfig.targetPort || frameworkPort,
        dist: devConfig.publish || dist || getDefaultDist({ log }),
        framework,
        env,
        pollingStrategies,
      }
    }
  } else if (devConfig.framework === '#custom') {
    validateFrameworkConfig({ devConfig })
    // when the users wants to configure `command` and `targetPort`
    settings = handleCustomFramework({ devConfig, log })
  } else if (devConfig.framework) {
    validateFrameworkConfig({ devConfig })
    // this is when the user explicitly configures a framework, e.g. `framework = "gatsby"`
    settings = await handleForcedFramework({ devConfig, projectDir })
  }

  validateConfiguredPort({ devConfig, detectedPort: settings.frameworkPort })

  const acquiredPort = await acquirePort({
    configuredPort: devConfig.port,
    defaultPort: DEFAULT_PORT,
    errorMessage: 'Could not acquire required "port"',
  })
  const functionsDir = devConfig.functions || settings.functions

  console.log(settings)
  return {
    ...settings,
    port: acquiredPort,
    jwtSecret: devConfig.jwtSecret || 'secret',
    jwtRolePath: devConfig.jwtRolePath || 'app_metadata.authorization.roles',
    functions: functionsDir,
    ...(functionsDir && { functionsPort: await getPort({ port: devConfig.functionsPort || 0 }) }),
    ...(devConfig.https && { https: await readHttpsSettings(devConfig.https) }),
  }
}

const filterSettings = function (scriptInquirerOptions, input) {
  const filteredSettings = fuzzy.filter(
    input,
    scriptInquirerOptions.map((scriptInquirerOption) => scriptInquirerOption.name),
  )
  const filteredSettingNames = new Set(
    filteredSettings.map((filteredSetting) => (input ? filteredSetting.string : filteredSetting)),
  )
  return scriptInquirerOptions.filter((t) => filteredSettingNames.has(t.name))
}

const formatSettingsArrForInquirer = function (frameworks) {
  return [].concat(
    ...frameworks.map((framework) =>
      framework.watch.commands.map((command) => ({
        name: `[${chalk.yellow(framework.name)}] ${framework.command} ${command.join(' ')}`,
        value: { ...framework, commands: [command] },
        short: `${framework.name}-${command}`,
      })),
    ),
  )
}

module.exports = {
  detectServerSettings,
}