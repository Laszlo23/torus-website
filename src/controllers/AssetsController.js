/**
 * Asset Controller
 *
 * Controller stores the assets and exposes some convienient methods
 */

import { ObservableStore } from '@metamask/obs-store'
import log from 'loglevel'
import { isAddress, toChecksumAddress } from 'web3-utils'

import { CONTRACT_TYPE_ERC721, CONTRACT_TYPE_ERC1155, NFT_SUPPORTED_NETWORKS } from '../utils/enums'
import { get } from '../utils/httpHelpers'

const SUPPORTED_NFT_STANDARDS = new Set([CONTRACT_TYPE_ERC1155, CONTRACT_TYPE_ERC721])

const initStateObject = { allCollectibleContracts: {}, allCollectibles: {}, allTokens: {}, collectibleContracts: [], collectibles: [], tokens: [] }

function getObjectFromArrayBasedonKey(oldArray, key) {
  return oldArray.reduce((acc, x) => {
    acc[x[key]] = x
    return acc
  }, {})
}

const mergeContractArrays = (oldArray, newArray) => {
  const oldMap = getObjectFromArrayBasedonKey(oldArray || [], 'address')
  const newMap = getObjectFromArrayBasedonKey(newArray || [], 'address')
  const finalArr = newArray
  Object.keys(oldMap).forEach((x) => {
    if (!newMap[x]) finalArr.push(oldMap[x])
  })
  return finalArr
}

const mergeCollectibleArrays = (oldArray, newArray) => {
  const oldMap = getObjectFromArrayBasedonKey(oldArray || [], 'collectibleIndex')
  const newMap = getObjectFromArrayBasedonKey(newArray || [], 'collectibleIndex')
  const finalArr = newArray
  Object.keys(oldMap).forEach((x) => {
    if (!newMap[x]) finalArr.push(oldMap[x])
  })
  return finalArr
}
export default class AssetController {
  constructor(options = {}) {
    this.name = 'AssetsController'
    this.store = new ObservableStore(initStateObject)
    this.network = options.network
    this.assetContractController = options.assetContractController
    this.selectedAddress = options.selectedAddress
    this.getNftMetadata = options.getNftMetadata
    this.initializeNetworkSubscription()
  }

  get state() {
    return this.store.getState()
  }

  initializeNetworkSubscription() {
    this.network.store.subscribe(({ provider }) => {
      const { allCollectibleContracts, allCollectibles, allTokens } = this.state
      const { selectedAddress } = this
      const networkType = provider.type
      this.store.updateState({
        collectibleContracts: (allCollectibleContracts[selectedAddress] && allCollectibleContracts[selectedAddress][networkType]) || [],
        collectibles: (allCollectibles[selectedAddress] && allCollectibles[selectedAddress][networkType]) || [],
        tokens: (allTokens[selectedAddress] && allTokens[selectedAddress][networkType]) || [],
      })
    })
  }

  setSelectedAddress(address) {
    this.selectedAddress = address
    const { allCollectibleContracts, allCollectibles, allTokens } = this.state
    const networkType = this.network.getNetworkNameFromNetworkCode()
    this.store.updateState({
      collectibleContracts: (allCollectibleContracts[address] && allCollectibleContracts[address][networkType]) || [],
      collectibles: (allCollectibles[address] && allCollectibles[address][networkType]) || [],
      tokens: (allTokens[address] && allTokens[address][networkType]) || [],
    })
  }

  getCollectibleApi(contractAddress, tokenId) {
    const networkType = this.network.getNetworkNameFromNetworkCode()
    const chainId = NFT_SUPPORTED_NETWORKS[networkType]
    if (chainId) {
      return `https://api.covalenthq.com/v1/${chainId}/tokens/${contractAddress}/nft_metadata/${tokenId}/`
    }
    return ''
  }

  /**
   * Adds a token to the stored token list
   *
   * @param address2 - Hex address of the token contract
   * @param symbol - Symbol of the token
   * @param decimals - Number of decimals the token uses
   * @param image - Image of the token
   * @returns - Current token list
   */
  async addToken(address2, symbol, decimals, image) {
    try {
      let address
      if (isAddress(address)) address = toChecksumAddress(address2)
      else address = address2
      const { selectedAddress } = this
      const { allTokens, tokens } = this.state
      const networkType = this.network.getNetworkNameFromNetworkCode()
      const newEntry = { address, symbol, decimals, image }
      const previousIndex = tokens.findIndex((token) => token.address === address)
      if (previousIndex > -1) {
        tokens[previousIndex] = newEntry
      } else {
        tokens.push(newEntry)
      }
      const addressTokens = allTokens[selectedAddress]
      const newAddressTokens = { ...addressTokens, [networkType]: tokens }
      const newAllTokens = { ...allTokens, [selectedAddress]: newAddressTokens }
      const newTokens = [...tokens]
      this.store.updateState({
        allTokens: newAllTokens,
        tokens: newTokens,
      })
      return newTokens
    } catch (error) {
      log.error(error)
      return {}
    }
  }

  /**
   * Get collectible tokenURI API following ERC721/ERC1155
   *
   * @param contractAddress - ERC721/ERC1155 asset contract address
   * @param tokenId - ERC721/ERC1155 asset identifier
   * @param interfaceStandard - ERC721/ERC1155 standard
   * @returns - Collectible tokenURI
   */
  async getCollectibleTokenURI(contractAddress, tokenId, interfaceStandard) {
    try {
      return this.assetContractController.getCollectibleTokenURI(contractAddress, tokenId, interfaceStandard)
    } catch (error) {
      log.error(error)
    }
    return ''
  }

  /**
   * Request individual collectible information from contracts that follows Metadata Interface
   *
   * @param contractAddress - Hex address of the collectible contract
   * @param tokenId - The collectible identifier
   * @returns - Promise resolving to the current collectible name, balance, standard and image
   */
  async getCollectibleInformationFromTokenURI(contractAddress, tokenId) {
    const interfaceStandard = await this.assetContractController.checkNftStandard(contractAddress)
    const tokenURI = await this.getCollectibleTokenURI(contractAddress, tokenId, interfaceStandard)
    const object = await get(tokenURI)
    const image = Object.prototype.hasOwnProperty.call(object, 'image') ? 'image' : /* istanbul ignore next */ 'image_url'
    const tokenBalance =
      interfaceStandard === CONTRACT_TYPE_ERC721
        ? 1
        : await this.assetContractController.getErc1155Balance(contractAddress, this.selectedAddress, tokenId)
    return { image: object[image], name: object.name, tokenBalance, description: '', standard: interfaceStandard }
  }

  /**
   * Request individual collectible information from covalent api
   *
   * @param contractAddress - Hex address of the collectible contract
   * @param tokenId - The collectible identifier
   * @returns - Promise resolving to the current collectible name, tokenBalance, standard and image
   */
  async getCollectibleInfoFromApi(contractAddress, tokenId) {
    const collectibleApi = this.getCollectibleApi(contractAddress, tokenId)
    let collectibleInfo = { name: null, image: null, description: null, tokenBalance: null, standard: null }
    if (!collectibleApi) {
      return collectibleInfo
    }
    const res = await this.getNftMetadata(collectibleApi)
    const contractData = res.data?.data?.items || []
    if (contractData.length > 0) {
      const { nft_data: nftData } = contractData[0]
      if (nftData.length > 0 && !!nftData[0].external_data) {
        let standard = CONTRACT_TYPE_ERC721
        if (nftData[0].supports_erc.includes(CONTRACT_TYPE_ERC1155)) {
          standard = CONTRACT_TYPE_ERC1155
        }
        const tokenBalance =
          standard === CONTRACT_TYPE_ERC721 ? 1 : await this.assetContractController.getErc1155Balance(contractAddress, this.selectedAddress, tokenId)
        const { name, image, description } = nftData[0].external_data
        collectibleInfo = { name, image, description, tokenBalance, standard }
        return collectibleInfo
      }
    }
    return collectibleInfo
  }

  /**
   * Request individual collectible information from covalent api or smart contract
   *
   * @param contractAddress - Hex address of the collectible contract
   * @param tokenId - The collectible identifier
   * @returns - Promise resolving to the current collectible name, tokenBalance, standard, description and image
   */
  async getCollectibleInfo(contractAddress, tokenId, detectFromApi) {
    try {
      if (detectFromApi) {
        const info = await this.getCollectibleInfoFromApi(contractAddress, tokenId)
        if (info.name && info.image) {
          return info
        }
      }
      const info = await this.getCollectibleInformationFromTokenURI(toChecksumAddress(contractAddress), tokenId)

      return info
    } catch {
      return {}
    }
  }

  /**
   * Request collectible contract information from the contract itself
   *
   * @param contractAddress - Hex address of the collectible contract
   * @returns - Promise resolving to the current collectible conract name, symbol and standard
   */
  async getCollectibleContractInformationFromContract(contractAddress, standard) {
    const assetsContractController = this.assetContractController
    const name = await assetsContractController.getAssetName(contractAddress)
    const symbol = await assetsContractController.getAssetSymbol(contractAddress)
    return { name, symbol, standard }
  }

  /**
   * Request individual collectible contract information from covalent api
   *
   * @param contractAddress - Hex address of the collectible contract
   * @returns - Promise resolving to the current collectible name, symbol and logo
   */
  async getCollectibleContractInformationFromApi(contractAddress) {
    // tokenid is required in covalent api, but any random id can be passed
    // it will return correct contract information if contract exist even if
    // token id is incorrect.
    const collectibleContractApi = this.getCollectibleApi(contractAddress, 1)
    const res = await this.getNftMetadata(collectibleContractApi)
    const contractData = res.data?.data?.items || []
    if (contractData.length > 0) {
      const { contract_name: name, contract_ticker_symbol: symbol, logo_url: logo } = contractData[0]
      return { name, symbol, logo }
    }
    return { name: null, symbol: null, logo: null }
  }

  /**
   * get collectible contract info from blockchain
   *
   * @param contractAddress - Hex address of the collectible contract
   * @returns - Promise resolving to the collectible contract name, logo, standard and description
   */
  async getCollectibleContractInformation(contractAddress, detectFromApi) {
    try {
      const standard = await this.assetContractController.checkNftStandard(contractAddress)
      if (detectFromApi) {
        const information = await this.getCollectibleContractInformationFromApi(contractAddress)
        if (information.name && information.symbol) {
          return { ...information, standard }
        }
      }
      const information = await this.getCollectibleContractInformationFromContract(contractAddress)
      if (information) {
        return { ...information, standard }
      }
      /* istanbul ignore next */
      return {}
    } catch (error) {
      log.error('getCollectibleContractInformation ', error)
    }
    return {}
  }

  async _normalizeContractDetails(contractDetails = {}, detectFromApi) {
    let normalizedContractInfo = {}
    const { contractName, contractSymbol, standard, contractAddress, contractImage, contractDescription } = contractDetails
    let _contractAddress
    if (isAddress(contractAddress)) _contractAddress = toChecksumAddress(contractAddress)
    else _contractAddress = contractAddress

    if (contractName && contractSymbol && standard) {
      normalizedContractInfo = {
        standard,
        address: _contractAddress,
        description: contractDescription || '',
        logo: contractImage,
        name: contractName,
        symbol: contractSymbol,
      }
    } else {
      // fetch from api or smart contract
      normalizedContractInfo = await this.getCollectibleContractInformation(contractAddress, detectFromApi)
      normalizedContractInfo.logo = normalizedContractInfo.logo ? normalizedContractInfo.logo : contractImage
      normalizedContractInfo.address = _contractAddress
      normalizedContractInfo.description = contractDescription || ''
    }
    if (!normalizedContractInfo.standard) {
      try {
        normalizedContractInfo.standard = await this.assetContractController.checkNftStandard(contractAddress)
      } catch {
        // return empty obj if not able to get contract standard, which means provided address is invalid
        return {}
      }
    }
    return normalizedContractInfo
  }

  async _normalizeCollectibleDetails(collectibleDetails = {}, detectFromApi) {
    const { name, image, description, standard, tokenBalance, address, tokenID } = collectibleDetails
    let _contractAddress
    if (isAddress(address)) _contractAddress = toChecksumAddress(address)
    else _contractAddress = address
    const collectibleIndex = `${_contractAddress}_${tokenID}`
    let normalizedCollectibleInfo = {
      address: _contractAddress,
      tokenId: tokenID,
      name,
      image,
      description,
      standard,
      tokenBalance,
      collectibleIndex,
    }
    if (!name || !image || !standard || !SUPPORTED_NFT_STANDARDS.has(standard)) {
      const collectibleInfo = await this.getCollectibleInfo(address, tokenID, detectFromApi)
      normalizedCollectibleInfo = { ...normalizedCollectibleInfo, ...collectibleInfo }
    }
    if (!normalizedCollectibleInfo.tokenBalance) {
      if (normalizedCollectibleInfo.standard === CONTRACT_TYPE_ERC721) {
        normalizedCollectibleInfo.tokenBalance = 1
      } else if (normalizedCollectibleInfo.standard === CONTRACT_TYPE_ERC1155) {
        try {
          await this.assetContractController.getErc1155Balance(_contractAddress, this.selectedAddress, tokenID)
        } catch {
          normalizedCollectibleInfo.tokenBalance = null
        }
      }
    }
    return normalizedCollectibleInfo
  }

  /**
   * Adds a collectible and respective collectible contract to the stored collectible and collectible contracts lists
   *
   * @param collectibles - array of collectibles , where each object is contains contractAddress, tokenID and
   * options (name, description, standard, image , tokenBalance)
   * @param detectFromApi - fetch token details from api if true is sent
   * @returns - Promise resolving to the current collectible list
   */
  async addCollectibles(collectibles = [], detectFromApi = true) {
    try {
      const newCollectibleContracts = []
      const newCollectibles = []
      const collectibleTempIndex = {}
      const contractPromises = []
      const collectiblePromises = []
      for (const collectibleDetails of collectibles) {
        const collectibleInfo = typeof collectibleDetails === 'object' ? collectibleDetails : {}
        const options = typeof collectibleInfo.options === 'object' ? collectibleInfo.options : {}

        const { contractName, contractSymbol, contractImage, contractDescription, description, image, name, tokenBalance, standard } = options

        const { tokenID, contractAddress } = collectibleInfo

        if (tokenID && contractAddress) {
          const collectibleIndex = `${contractAddress}_${tokenID}`
          try {
            if (!collectibleTempIndex[contractAddress]) {
              const normalizedContractPromise = this._normalizeContractDetails(
                {
                  contractAddress,
                  contractName,
                  contractSymbol,
                  standard,
                  contractImage,
                  contractDescription,
                },
                detectFromApi
              )
              contractPromises.push(normalizedContractPromise)
              collectibleTempIndex[contractAddress] = true
            }
            if (!collectibleTempIndex[collectibleIndex]) {
              const normalizedCollectiblePromise = this._normalizeCollectibleDetails(
                {
                  address: contractAddress,
                  name,
                  image,
                  description,
                  standard,
                  tokenBalance,
                  tokenID,
                },
                detectFromApi
              )
              collectiblePromises.push(normalizedCollectiblePromise)
              collectibleTempIndex[collectibleIndex] = true
            }
          } catch (error) {
            log.error(error)
          }
        }
      }
      const allAssetPromises = await Promise.all([...contractPromises, ...collectiblePromises])
      for (const [i, assetDetail] of allAssetPromises.entries()) {
        // first add contracts
        if (i < contractPromises.length) {
          if (assetDetail.name && assetDetail.symbol) {
            newCollectibleContracts.push(assetDetail)
          }
        } else if (assetDetail.name && assetDetail.standard && assetDetail.tokenBalance) {
          // rest are assets
          newCollectibles.push(assetDetail)
        }
      }
      const initState = this.state
      const { allCollectibles, collectibles: oldCollectibles, allCollectibleContracts, collectibleContracts: oldCollectibleContracts } = initState

      const finalContracts = mergeContractArrays(oldCollectibleContracts, newCollectibleContracts)

      const finalCollectibles = mergeCollectibleArrays(oldCollectibles, newCollectibles)

      const { selectedAddress } = this
      const networkType = this.network.getNetworkNameFromNetworkCode()

      const addressCollectibles = allCollectibles[selectedAddress]
      const newAddressCollectibles = { ...addressCollectibles, ...{ [networkType]: finalCollectibles } }
      const newAllCollectibles = { ...allCollectibles, ...{ [selectedAddress]: newAddressCollectibles } }

      const addressCollectibleContracts = allCollectibleContracts[selectedAddress]
      const newAddressCollectibleContracts = {
        ...addressCollectibleContracts,
        [networkType]: finalContracts,
      }

      const newAllCollectibleContracts = {
        ...allCollectibleContracts,
        [selectedAddress]: newAddressCollectibleContracts,
      }
      this.store.updateState({
        allCollectibleContracts: newAllCollectibleContracts,
        collectibleContracts: newCollectibleContracts,
        allCollectibles: newAllCollectibles,
        collectibles: newCollectibles,
      })
    } catch (error) {
      log.error(error)
    }
  }
}
