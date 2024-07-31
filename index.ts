import { parse as toml_parse, stringify as toml_stringify, type TomlPrimitive } from "smol-toml"
import { z } from "zod"
import { Command } from "@commander-js/extra-typings"
import { input } from "@inquirer/prompts"
import { Octokit, App } from "octokit"

function mapAsync<T, U>(
	array: T[],
	callbackfn: (value: T, index: number, array: T[]) => Promise<U>,
): Promise<U[]> {
	return Promise.all(array.map(callbackfn))
}

async function filterAsync<T>(
	array: T[],
	callbackfn: (value: T, index: number, array: T[]) => Promise<boolean>,
): Promise<T[]> {
	const filterMap = await mapAsync(array, callbackfn)
	return array.filter((value, index) => filterMap[index])
}

function escapeRegex(str: string) {
	return str.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&")
}

function resolvePlaceholders(str: string): string {
	return str
		.replaceAll("{mc_version}", escapeRegex(versions.minecraft))
		.replaceAll("{loader}", escapeRegex(loader))
}

function stringToRegex(str: string): RegExp {
	return new RegExp(resolvePlaceholders(str))
}

function hashToHex(hash: ArrayBuffer): string {
	const hash_array = Array.from(new Uint8Array(hash))
	const hash_hex = hash_array.map((b) => b.toString(16).padStart(2, "0")).join("")
	return hash_hex
}

const index_schema = z.object({
	"hash-format": z.string(),
	files: z.array(z.object({ file: z.string(), hash: z.string(), metafile: z.boolean() })),
})

const ModSchema = z.object({
	name: z.string(),
	filename: z.string(),
	side: z.string(),
	download: z.object({
		url: z.string(),
		"hash-format": z.string(),
		hash: z.string(),
	}),
	packwiz_gh_release: z.object({
		owner: z.string(),
		repo: z.string(),
		release_name_regex: z.string(),
		file_name_regex: z.string(),
	}),
})
type Mod = z.infer<typeof ModSchema>

const program = new Command()

const octokit = new Octokit({
	userAgent: "packwiz-gh-release tool",
})

const versions = toml_parse(await Bun.file("pack.toml").text()).versions as {
	minecraft: string
	fabric?: string
	quilt?: string
	forge?: string
	neoforge?: string
}
const loader = Object.keys(versions).filter((key) => {
	return ["fabric", "quilt", "forge", "neoforge"].includes(key)
})[0]
const index = index_schema.parse(toml_parse(await Bun.file("./index.toml").text()))

async function update_mod(mod: Mod): Promise<Mod | undefined> {
	const releases_iterator = octokit.paginate.iterator(octokit.rest.repos.listReleases, {
		owner: mod.packwiz_gh_release.owner,
		repo: mod.packwiz_gh_release.repo,
	})
	for await (const { data: releases } of releases_iterator) {
		for (const release of releases) {
			if (stringToRegex(mod.packwiz_gh_release.release_name_regex).test(release.name || "")) {
				const assets = (
					await octokit.rest.repos.listReleaseAssets({
						owner: mod.packwiz_gh_release.owner,
						repo: mod.packwiz_gh_release.repo,
						release_id: release.id,
						per_page: 50,
					})
				).data
				for (const asset of assets) {
					if (stringToRegex(mod.packwiz_gh_release.file_name_regex).test(asset.name)) {
						const hash = hashToHex(
							await crypto.subtle.digest(
								"SHA-1",
								await (await fetch(asset.browser_download_url)).arrayBuffer(),
							),
						)
						return {
							...mod,
							filename: asset.name,
							download: {
								url: asset.browser_download_url,
								"hash-format": "sha1",
								hash: hash,
							},
						}
					}
				}
			}
		}
	}
	console.error(`Could not update ${mod.name}`)
}

program.command("update").action(async () => {
	const mods = await mapAsync(
		await filterAsync(index.files, async (file) => {
			return (
				file.metafile &&
				Object.keys(toml_parse(await Bun.file(file.file).text())).includes("packwiz_gh_release")
			)
		}),
		async (file) => {
			return {
				filename: file.file,
				mod: ModSchema.parse(toml_parse(await Bun.file(file.file).text())),
			}
		},
	)

	for (const { filename, mod } of mods) {
		await Bun.write(filename, toml_stringify(await update_mod(mod)))
	}

	await Bun.spawn(["packwiz", "refresh"], {
		stdio: ["inherit", "inherit", "inherit"],
	}).exited
})

program
	.command("add")
	.argument("<repo>", 'The Github repository, For example: "gnembon/fabric-carpet"')
	.argument("<name>", 'The mod name. For example: "Carpet"')
	.argument("<path>", 'Where to put the generated .pw.toml. For example: "mods/carpet.pw.toml"')
	.option(
		"-s, --side <side>",
		'The side of the mod. Should be one of "server", "client", or "both". default is "both"',
		"both",
	)
	.action(async (repo_full, name, path, options) => {
		const [owner, repo] = repo_full.split("/")
		const release_name_regex = await input({
			message: "Enter a regex for the release name. Include the ^ and $.",
			required: true,
			default: "^.* {mc_version}$",
		})
		const file_name_regex = await input({
			message: 'Enter a regex for the file name. Include the "^" and "$".',
			required: true,
			default: "^.*\\.jar$",
		})
		await Bun.write(
			path,
			toml_stringify(
				await update_mod({
					name: name,
					side: options.side,
					filename: "",
					download: {
						url: "",
						"hash-format": "",
						hash: "",
					},
					packwiz_gh_release: {
						owner: owner,
						repo: repo,
						release_name_regex: release_name_regex,
						file_name_regex: file_name_regex,
					},
				}),
			),
		)
	})

await program.parseAsync()
