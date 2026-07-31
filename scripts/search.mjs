import {
  fetchChinaRoleOptions,
  searchChinaStrategies,
} from "../src/search.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run search -- <China URL or lineup ID>",
    "  npm run search -- --keyword <text> [--author <name>] [--roles <id,id,...>]",
    "  npm run search -- --author <name> [--keyword <text>] [--roles <id,id,...>]",
    "  npm run search -- --list-roles [name filter]",
    "",
    "Options:",
    "  --max-pages <1-100>   Recommendation pages to scan (default: 10)",
    "  --page-size <1-50>    Strategies fetched per page (default: 10)",
    "  --order <Hot|CreatedTime>",
  ].join("\n");
}

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

function parseArguments(args) {
  const parsed = {
    source: "",
    keyword: "",
    authorKeyword: "",
    roleIds: [],
    maxPages: 10,
    pageSize: 10,
    order: "Hot",
    listRoles: false,
    roleNameFilter: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--keyword") {
      parsed.keyword = requireValue(args, index, argument);
      index += 1;
    } else if (argument === "--roles") {
      parsed.roleIds = requireValue(args, index, argument)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
    } else if (argument === "--author") {
      parsed.authorKeyword = requireValue(args, index, argument);
      index += 1;
    } else if (argument === "--max-pages") {
      parsed.maxPages = Number(requireValue(args, index, argument));
      index += 1;
    } else if (argument === "--page-size") {
      parsed.pageSize = Number(requireValue(args, index, argument));
      index += 1;
    } else if (argument === "--order") {
      parsed.order = requireValue(args, index, argument);
      index += 1;
    } else if (argument === "--list-roles") {
      parsed.listRoles = true;
      const possibleFilter = args[index + 1];
      if (possibleFilter && !possibleFilter.startsWith("--")) {
        parsed.roleNameFilter = possibleFilter;
        index += 1;
      }
    } else if (argument.startsWith("--")) {
      throw new TypeError(`Unknown option: ${argument}`);
    } else if (!parsed.source) {
      parsed.source = argument;
    } else {
      throw new TypeError(`Unexpected argument: ${argument}`);
    }
  }

  return parsed;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return;
  }

  if (parsed.listRoles) {
    const result = await fetchChinaRoleOptions();
    const filter = parsed.roleNameFilter
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN");
    console.log(
      JSON.stringify(
        {
          ...result,
          roles: result.roles.filter((role) =>
            role.name
              .normalize("NFKC")
              .toLocaleLowerCase("zh-CN")
              .includes(filter),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }

  const result = await searchChinaStrategies(parsed);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  console.error(usage());
  process.exitCode = 1;
});
