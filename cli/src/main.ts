import c from "picocolors"
import { program } from "commander"
import fs from "fs-extra"
import glob from "fast-glob"
import { join } from "node:path"
import path from "node:path"
import chokidar from "chokidar"
import ora from "ora"
import { compile } from "@danielx/civet"

function debounce<T>(func: T, timeout = 1000): T {
    let timer = null as any
    return (
        (...args: any) => { 
            clearTimeout(timer)
            return timer = setTimeout(() => (func as any)(...args), timeout)
    }
    ) as any
}

const cwd = process.cwd()

type Options = {tsx: boolean, noGit: boolean, noVscode: boolean}
let opts = null as unknown as Options
const defaultOpts: Options = {tsx: false, noGit: false, noVscode: false}


const collectFiles = async () => { 
    return new Set(await glob("**/*.civet", {ignore: ["node_modules/**/*", "dist/**/*"], cwd: cwd}))
}
    

const step = async (desc: string, fn: any) => { 
    const spinner = ora(desc)
    spinner.start()
    await Promise.resolve(fn())
    return spinner.stop()
}

const compileFile = async (file: string) => {
    const a = 5 + 7
    const content = await fs.readFile(file, "utf8")
    const compiled = await compile(content, ({inlineMap: true, filename: file}) as any)
    return `// Source: ${file}
// Generated by Civetman

${compiled}`
}

const fileToOutFile = (file: string, tsx: boolean) => file.replace(".civet", tsx ? ".tsx" : ".ts")

const buildFile = async (file: string, tsx: boolean) => {
    const outFile = fileToOutFile(file, tsx)
    const compiled = await compileFile(file)
    await fs.writeFile(outFile, compiled, "utf8")
    return outFile
}

const civetmanVscodeConfigPlaceholder = "below is generated by civetman"
const vscodeConfigFileExludeKey = "files.exclude"
const vscodeConfigDir = join(cwd, ".vscode")
const vscodeConfigFile = join(vscodeConfigDir, "settings.json")
const addVscodeConfigFileExclude = debounce(async (files: string[]) => { 
    if (opts.noVscode) return

    const spinner = ora(c.blue(`Adding exclude files to VSCode config`))
    spinner.start()

    await fs.ensureDir(vscodeConfigDir)
    await fs.ensureFile(vscodeConfigFile)
    const vscconfig = JSON.parse((await fs.readFile(vscodeConfigFile)).toString().trim() || "{}")
    if (!vscconfig[vscodeConfigFileExludeKey]) vscconfig[vscodeConfigFileExludeKey] = {}

    let found = false
    vscconfig[vscodeConfigFileExludeKey] = [
        ...Object.keys(vscconfig[vscodeConfigFileExludeKey]).reduce((prev: string[], curr: string) => { 
            if (curr === civetmanVscodeConfigPlaceholder) found = true
            return found ? prev : [...prev, curr]
        }
           , []), 
        civetmanVscodeConfigPlaceholder, 
        ...files,
    ].reduce((prev, file) => ({ ...prev, [file]: true }), {})

    await fs.writeFile(vscodeConfigFile, (JSON.stringify(vscconfig, null, "\t")), "utf8")

    spinner.stop()
    return spinner.succeed()
}
)

const gitignoreFile = join(cwd, ".gitignore")
const gitignoreStart = `# Generated by Civetman
# DO NOT ADD CONTENT BELOW THIS (They will be removed by Civetman)`
const addGitignore = debounce(
    async (files: string[]) => { 
        if (opts.noGit) return

        const spinner = ora(c.blue(`Adding files to .gitignore`))
        spinner.start()

        await fs.ensureFile(gitignoreFile)
        const gitignore = await fs.readFile(gitignoreFile, "utf8")
        const start = gitignore.indexOf(gitignoreStart)
        const before = start === -1 ? gitignore : gitignore.slice(0, start)
        const content = `${before.trimEnd()}

${gitignoreStart}
${files.join("\n")}`
        await fs.writeFile(gitignoreFile, content, "utf8")

        spinner.stop()
        return spinner.succeed()
    }
)
    
program
    .name("civetman") 
    .description("Use Civet in any projects!") 
    .version("0.0.1")
    .option("-x, --tsx, --jsx", "Generate `.tsx` files instead of `.ts` files")
    .option("--noGit", "Civetman without writing `.gitignore` file")
    .option("--noVscode", "Civetman without writing `.vscode/settings.json` file")

program
    .command("build")
    .description("Start building Civet files") 
    .action(async () => { 
        console.log(c.blue(`Civetman starts building...\n`))

        const spinner = ora(c.blue(`Building Civet files\n`))
        const files = await collectFiles()
        const outFiles = [] as string[]
        for (const file of files) {
            const outFile = await buildFile(file, opts.tsx)
            outFiles.push(outFile)
            spinner.succeed(`${c.cyan(file)} -> ${c.green(outFile)}`)
        }
        spinner.stop()
        spinner.succeed("All Civet files built!\n")
        
        await addVscodeConfigFileExclude(outFiles)
        await addGitignore(outFiles)

        console.log(c.green(`\nCivetman finished building!`))

        return
})

program
    .command("dev")
    .description("Start building Civet files in watch mode")
    .action(async () => { 
        console.log(c.blue(`Civetman starts building in watch mode...\n`))
        const spinner = ora(c.blue(`Building Civet files\n`))

        const files = await collectFiles()
        const outFiles = new Set<string>()

        const buildOneFile = async (file: string) => { 
            try {
                const outFile = await buildFile(file, opts.tsx)
                outFiles.add(outFile)
                return spinner.succeed(`${c.cyan(file)} -> ${c.green(outFile)}`)
            }
            catch (e) {
            	return console.error(e)(
                spinner.fail(`${c.cyan(file)}`),)
            }
        }

        const watcher = chokidar.watch([...files, cwd], {ignored: [/node_modules/gi, /dist/gi]})
        watcher.on("add", async (fileAbsolute) => { 
            const file = path.relative(cwd, fileAbsolute)
            if (file.endsWith(".civet")) { 
                await buildOneFile(file)
                files.add(file)
                watcher.add(file)
        
                await addVscodeConfigFileExclude([...outFiles])
                return await addGitignore([...outFiles])
            };return
        })
        
        watcher.on("change", async (fileAbsolute) => { 
            const file = path.relative(cwd, fileAbsolute)
            if (files.has(file)) {
                return await buildOneFile(file)
            };return
        })
        
        watcher.on('unlink', async (fileAbsolute) => { 
            const file = path.relative(cwd, fileAbsolute)
            if (files.has(file)) {
                files.delete(file)
                const outFile = fileToOutFile(file, opts.tsx)
                outFiles.delete(outFile)
                fs.unlink(join(cwd, outFile))
        
                await addVscodeConfigFileExclude([...outFiles])
                return await addGitignore([...outFiles])
            };return
        })

        process.on('beforeExit', () => watcher.close())

        return
})

export default () => { 
    program.hook('preAction' , () => { opts = { ...defaultOpts, ...program.opts<Options>() }; })
    return program.parse(process.argv)
}
