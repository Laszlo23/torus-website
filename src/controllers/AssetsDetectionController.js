/**
 * Assets Detection
 * Controller that passively polls on a set interval for assets auto detection
 */

import deepmerge from 'deepmerge'
import isEqual from 'lodash.isequal'
import log from 'loglevel'
import Web3 from 'web3'

import NftHandler from '../handlers/Token/NftHandler'
import {
  BSC_MAINNET,
  CONTRACT_TYPE_ERC721,
  CONTRACT_TYPE_ERC1155,
  MAINNET,
  MATIC,
  NFT_SUPPORTED_NETWORKS,
  SUPPORTED_NFT_STANDARDS,
} from '../utils/enums'
import { isMain } from '../utils/utils'

const DEFAULT_INTERVAL = 60_000
export default class AssetsDetectionController {
  constructor(options) {
    this.interval = options.interval || DEFAULT_INTERVAL
    this.selectedAddress = options.selectedAddress || ''
    this.network = options.network
    this._provider = options.provider
    this.web3 = new Web3(this._provider)
    this.assetController = options.assetController
    this.getCovalentNfts = options.getCovalentNfts
    this.getOpenSeaCollectibles = options.getOpenSeaCollectibles
    this.currentNetwork = null
    this.preferencesStore = options.preferencesStore
    this.selectedCustomNfts = []
  }

  restartAssetDetection() {
    if (!this.selectedAddress) {
      return
    }
    this.detectAssets()
    this.interval = DEFAULT_INTERVAL
  }

  /**
   * In setter when isUnlocked is updated to true, detectNewTokens and restart polling
   * @type {Object}
   */
  startAssetDetection(selectedAddress) {
    this.selectedAddress = selectedAddress
    this.restartAssetDetection()
  }

  stopAssetDetection() {
    this.selectedAddress = ''
  }

  isMainnet() {
    return this.network.getNetworkNameFromNetworkCode() === MAINNET
  }

  isMatic() {
    return this.network.getNetworkNameFromNetworkCode() === MATIC
  }

  /**
   * @type {Number}
   */
  set interval(interval) {
    if (this._handle) clearInterval(this._handle)
    if (!interval) {
      return
    }
    if (isMain)
      this._handle = setInterval(() => {
        this.detectAssets()
      }, interval)
  }

  async getCustomNfts(customNfts, forceUpdateStore = false) {
    const collectiblesMap = {}
    const userAddress = this.selectedAddress
    if (userAddress === '') return [[], collectiblesMap]

    this.selectedCustomNfts = customNfts.map((x) => x.nft_address)
    const localNetwork = this.network.getNetworkNameFromNetworkCode()
    const currentNetworkTokens = customNfts.reduce((acc, x) => {
      if (x.network === localNetwork) acc.push(x)
      return acc
    }, [])
    let nonZeroTokens = await Promise.all(
      currentNetworkTokens.map(async (x) => {
        try {
          const tokenInstance = new NftHandler({
            address: x.nft_address,
            tokenId: x.nft_id,
            userAddress: this.selectedAddress,
            nftStandard: x.nft_contract_standard,
            isSpecial: undefined,
            web3: this.web3,
          })
          const balance = await tokenInstance.fetchNftBalance()
          if (balance === 0) {
            throw new Error('Nft not owned by user anymore')
          }
          let { description, nft_image_link, nft_name } = x
          if (!description || !nft_image_link || !nft_name) {
            const nftMetadata = await tokenInstance.getNftMetadata()
            description = nftMetadata.decription
            nft_image_link = nftMetadata.nftImageLink
            nft_name = nftMetadata.nftName
          }
          const collectible = {
            contractAddress: x.nft_address,
            tokenID: x.nft_id.toString(),
            options: {
              contractName: nft_name,
              contractSymbol: nft_name,
              contractImage: nft_image_link,
              contractFallbackLogo: nft_image_link, // fallback is handled by nft handler
              standard: x.nft_contract_standard.toLowerCase(),
              contractDescription: description,
              description,
              image: nft_image_link,
              name: `${nft_name}#${x.nft_id}`,
              tokenBalance: balance,
            },
          }
          const collectibleIndex = `${x.nft_address.toLowerCase()}_${x.nft_id.toString()}`
          collectiblesMap[collectibleIndex] = collectible

          return collectible
        } catch (error) {
          log.warn('Invalid contract address while fetching', error)
          return undefined
        }
      })
    )
    nonZeroTokens = nonZeroTokens.filter((x) => x)
    if (forceUpdateStore) await this.assetController.addCollectibles(nonZeroTokens, false)
    return [nonZeroTokens, collectiblesMap]
  }

  getOwnerCollectiblesApi(address, apiType = 'covalent') {
    // from opensea
    if (apiType === 'opensea') {
      if (this.currentNetwork === MAINNET) {
        return `https://api.opensea.io/api/v1/assets?owner=${address}&limit=300`
      }
      if (this.currentNetwork === MATIC) {
        return `https://api.opensea.io/api/v2/assets/matic?owner=${address}&limit=300`
      }
      return ''
    }
    // from covalent api
    const chainId = NFT_SUPPORTED_NETWORKS[this.currentNetwork]
    if (chainId) {
      return `https://api.covalenthq.com/v1/${chainId}/address/${address}/balances_v2/?nft=true&no-nft-fetch=false`
    }
    return ''
  }

  async getOwnerCollectibles(apiType = 'covalent') {
    const { selectedAddress } = this
    const api = this.getOwnerCollectiblesApi(selectedAddress, apiType)
    let response
    try {
      if (apiType === 'covalent') {
        if (NFT_SUPPORTED_NETWORKS[this.currentNetwork]) {
          response = await this.getCovalentNfts(api)
          const collectibles = response.data?.data?.items || []
          return collectibles
        }
        return []
      }
      response = await this.getOpenSeaCollectibles(api)
      if (this.isMainnet()) {
        const collectibles = response.data.assets
        return collectibles
      }
      if (this.isMatic()) {
        const collectibles = response.data.results
        return collectibles
      }
      return []
    } catch (error) {
      log.error(error)
      return []
    }
  }

  /**
   * Detect assets owned by current account on mainnet
   */
  async detectAssets() {
    if (NFT_SUPPORTED_NETWORKS[this.network.getNetworkNameFromNetworkCode()]) {
      // this.detectTokens()
      this.detectCollectibles()
    }
  }

  /**
   * Triggers asset ERC721/ERC1155 token auto detection
   * adding new collectibles and removing not owned collectibles
   */
  async detectCollectibles() {
    /* istanbul ignore if */
    const currentNetwork = this.network.getNetworkNameFromNetworkCode()
    this.currentNetwork = currentNetwork
    let finalArr = []
    const userState = this._preferencesStore.getState()[this.selectedAddress]
    const { customNfts } = userState || {}
    let customCollectiblesMap = {}
    if (this._preferencesStore) {
      const [customNftArr, _customCollectiblesMap] = await this.getCustomNfts(customNfts)
      finalArr = [...customNftArr]
      customCollectiblesMap = _customCollectiblesMap
    }
    if (this.isMainnet() || this.isMatic()) {
      const [openseaAssets, covalentAssets] = await Promise.all([
        this.detectCollectiblesFromOpensea(),
        this.detectCollectiblesFromCovalent(currentNetwork),
      ])
      const [, covalentCollectiblesMap] = covalentAssets
      const [, openseaCollectiblesMap] = openseaAssets

      const openseaIndexes = Object.keys(openseaCollectiblesMap)
      if (openseaIndexes.length > 0) {
        Object.keys(openseaCollectiblesMap).forEach((x) => {
          if (!customCollectiblesMap[x]) {
            const openseaCollectible = openseaCollectiblesMap[x]
            const covalentCollectible = covalentCollectiblesMap[x]
            if (covalentCollectible) {
              const finalCollectible = deepmerge(covalentCollectible, openseaCollectible)
              finalArr.push(finalCollectible)
            } else {
              finalArr.push(openseaCollectible)
            }
          }
        })
      } else {
        Object.keys(covalentCollectiblesMap).forEach((x) => {
          if (!customCollectiblesMap[x]) {
            const covalentCollectible = covalentCollectiblesMap[x]
            if (covalentCollectible) {
              finalArr.push(covalentCollectible)
            }
          }
        })
      }
    } else {
      const [, covalentCollectiblesMap] = await this.detectCollectiblesFromCovalent(currentNetwork)
      Object.keys(covalentCollectiblesMap).forEach((x) => {
        if (!customCollectiblesMap[x]) {
          const covalentCollectible = covalentCollectiblesMap[x]
          if (covalentCollectible) {
            finalArr.push(covalentCollectible)
          }
        }
      })
    }

    await this.assetController.addCollectibles(finalArr, false)
  }

  async detectCollectiblesFromCovalent(network) {
    const { selectedAddress } = this
    const collectibles = []
    const collectiblesMap = {}
    /* istanbul ignore else */
    if (!selectedAddress) {
      return [collectibles, collectiblesMap]
    }
    let protocolPrefix = 'ERC'
    if (network === BSC_MAINNET) {
      protocolPrefix = 'BEP'
    }
    this.assetController.setSelectedAddress(selectedAddress)
    const apiCollectibles = await this.getOwnerCollectibles('covalent')
    for (const item of apiCollectibles) {
      if (item.type === 'nft') {
        let contractName = item.contract_name
        let standard
        const { logo_url, contract_address: contractAddress, contract_ticker_symbol: contractSymbol, nft_data } = item

        const contractImage = logo_url
        let contractFallbackLogo
        if (!!nft_data && nft_data.length > 0) {
          for (const [i, nft] of nft_data.entries()) {
            const { token_id: tokenID, token_balance: tokenBalance, external_data, supports_erc } = nft
            if (supports_erc.includes('erc1155')) {
              contractName = `${contractName} (${protocolPrefix}1155)`
              standard = CONTRACT_TYPE_ERC1155
            } else {
              contractName = `${contractName} (${protocolPrefix}721)`
              standard = CONTRACT_TYPE_ERC721
            }
            const name = external_data?.name
            const description = external_data?.description
            const imageURL = external_data?.image || '/images/nft-placeholder.svg'
            if (i === 0) {
              contractFallbackLogo = imageURL
            }
            const collectibleDetails = {
              contractAddress,
              tokenID: tokenID.toString(),
              options: {
                contractName,
                contractSymbol,
                contractImage,
                contractFallbackLogo,
                standard,
                contractDescription: '', // covalent api doesn't provide contract description like opensea
                description,
                image: imageURL,
                name: name || `${contractName}#${tokenID}`,
                tokenBalance,
              },
            }
            collectibles.push(collectibleDetails)
            const collectibleIndex = `${contractAddress.toLowerCase()}_${tokenID.toString()}`
            collectiblesMap[collectibleIndex] = collectibleDetails
          }
        }
      }
    }
    return [collectibles, collectiblesMap]
  }

  /**
   * Triggers asset ERC721 token auto detection on mainnet
   * adding new collectibles and removing not owned collectibles
   */
  async detectCollectiblesFromOpensea() {
    const finalCollectibles = []
    const collectiblesMap = {}
    /* istanbul ignore if */
    if (!this.isMainnet() && !this.isMatic()) {
      return [finalCollectibles, collectiblesMap]
    }
    const { selectedAddress } = this
    /* istanbul ignore else */
    if (!selectedAddress) {
      return [finalCollectibles, collectiblesMap]
    }
    this.assetController.setSelectedAddress(selectedAddress)
    const apiCollectibles = await this.getOwnerCollectibles('opensea')
    for (const {
      token_id: tokenID,
      image_url: imageURL,
      name,
      description,
      asset_contract: {
        schema_name: standard,
        address: contractAddress,
        name: contractName,
        symbol: contractSymbol,
        image_url: contractImage = '',
        total_supply: contractSupply,
        description: contractDescription,
      },
    } of apiCollectibles) {
      if (SUPPORTED_NFT_STANDARDS.has(standard?.toLowerCase())) {
        const collectible = {
          contractAddress,
          tokenID: tokenID.toString(),
          options: {
            standard: standard?.toLowerCase(),
            description,
            image: imageURL || (contractImage || '').replace('=s60', '=s240'),
            name: name || `${contractName}#${tokenID}`,
            contractAddress,
            contractName,
            contractSymbol,
            contractImage: (contractImage || '').replace('=s60', '=s240') || imageURL,
            contractSupply,
            contractDescription,
          },
        }
        finalCollectibles.push(collectible)
        const collectibleIndex = `${contractAddress.toLowerCase()}_${tokenID.toString()}`
        collectiblesMap[collectibleIndex] = collectible
      }
    }
    return [finalCollectibles, collectiblesMap]
  }

  set preferencesStore(preferencesStore) {
    if (this._preferencesStore) this._preferencesStore.unsubscribe()
    if (!preferencesStore) {
      return
    }
    this._preferencesStore = preferencesStore
    // set default maybe
    preferencesStore.subscribe(async (state) => {
      const { selectedAddress } = state
      if (!selectedAddress) return
      const { customNfts = [] } = state[selectedAddress]
      if (
        !isEqual(
          this.selectedCustomNfts,
          customNfts.map((x) => x.nft_address)
        )
      ) {
        this.getCustomNfts(customNfts, true)
      }
    })
  }
}

// /**
//  * Triggers asset ERC20 token auto detection for each contract address in contract metadata on mainnet
//  */
// async detectTokens() {
//   /* istanbul ignore if */
//   if (!this.isMainnet()) {
//     return
//   }
//   const tokensAddresses = this.store.getState().token.filter(/* istanbul ignore next*/ token => token.address)
//   const tokensToDetect = []
//   for (const address in contractMap) {
//     const contract = contractMap[address]
//     if (contract.erc20 && !(address in tokensAddresses)) {
//       tokensToDetect.push(address)
//     }
//   }

//   // log.info('AssetsDetectionController: detectTokens(): tokensTodetect[]:', tokensToDetect)
//   const assetsContractController = this.assetContractController
//   const { selectedAddress } = this.store.getState().selectedAddress
//   /* istanbul ignore else */
//   if (!selectedAddress) {
//     return
//   }
//   try {
//     const balances = await assetsContractController.getBalancesInSingleCall(selectedAddress, tokensToDetect)
//     const assetsController = this.assetContractController
//     const { ignoredTokens } = assetsController.state
//     for (const tokenAddress in balances) {
//       let ignored
//       /* istanbul ignore else */
//       if (ignoredTokens.length) {
//         ignored = ignoredTokens.find(token => token.address === ethereumjs_util.toChecksumAddress(tokenAddress))
//       }
//       if (!ignored) {
//         await assetsController.addToken(tokenAddress, contractMap[tokenAddress].symbol, contractMap[tokenAddress].decimals)
//       }
//     }
//   } catch (err) {
//     log.error(err)
//   }
// }
