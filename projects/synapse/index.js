const { chainExports } = require("../helper/exports");
const { request, gql } = require("graphql-request");
const { getBlock } = require("../helper/getBlock");
const { default: axios } = require("axios");
const sdk = require("@defillama/sdk");
const retry = require("async-retry");
const ethers = require("ethers");

const MIM_FANTOM = "0x82f0b8b456c1a451378467398982d4834b6829c1";
const gqlQuery = gql`
  query getTVL($block: Int) {
    swaps(block: { number: $block }) {
      tokens(orderBy: symbol, orderDirection: asc) {
        id
        name
        decimals
      }
      balances
    }
  }
`;

const changeNumDecimals = (number, toDecimals) => {
  return ethers.utils.bigNumberify(number).div(10 ** toDecimals);
};

// TODO: Support Arb nUSD pool.
function chainTvl(chain) {
  return async (timestamp, ethBlock, chainBlocks) => {
    const transform = (token) => `${chain}:${token}`;
    const balances = {};

    const block = await getBlock(timestamp, chain, chainBlocks);
    const { data } = await retry(
      async (_) => await axios.get("https://synapse.dorime.org/defillama.json")
    );

    const unsupportedTokens = data.unsupported;
    const tokens = data.bridges[chain];
    const url = data.subgraphs[chain];
    if (tokens === undefined || url === undefined) return balances;

    const { swaps } = await retry(
      async (_) => await request(url, gqlQuery, { block })
    );

    for (const swap of swaps) {
      // So it seems like our luck of ordering by `symbol` has ran out.
      // Time to start thinking like an ape now and sort this object
      // By moving MIM object to the front to be in 'union' with balance.
      if (chain == "fantom") {
        const mim = swap.tokens.filter((x) => {
          return x.id == MIM_FANTOM;
        });

        if (mim.length > 0) {
          swap.tokens = swap.tokens.filter((x) => x.id !== MIM_FANTOM);
          swap.tokens.unshift(mim[0]);
        }
      }

      for (let i = 0; i < swap.tokens.length; i++) {
        if (swap.tokens[i].name == "USD LP") continue;

        // There is no data on price for `nUSD` so we change it to an obscure
        // stablecoin, which does have data on price but is not used in any of the pools.
        if (unsupportedTokens.includes(swap.tokens[i].name)) {
          swap.tokens[i].id = tokens.obscure;
          // Convert the decimals as well. (e.g 18d -> 6d)
          const decimals = swap.tokens[i].decimals - tokens["obscure-decimals"];
          if (decimals > 0)
            swap.balances[i] = changeNumDecimals(swap.balances[i], decimals);
        }

        sdk.util.sumSingleBalance(
          balances,
          transform(swap.tokens[i].id),
          swap.balances[i]
        );
      }
    }

    return balances;
  };
}

module.exports = chainExports(chainTvl, [
  "ethereum",
  "bsc",
  "polygon",
  "avax",
  "fantom",
  "arbitrum",
]);