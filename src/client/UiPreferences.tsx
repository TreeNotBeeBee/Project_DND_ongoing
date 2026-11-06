import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
export interface UiPreferences {language:'zh-CN'|'en-US';theme:'system'|'dark'|'light'}
const key='jigerpg_ui_preferences_v1';
function read():UiPreferences{try{const value=JSON.parse(localStorage.getItem(key)||'{}');return{language:value.language==='en-US'?'en-US':'zh-CN',theme:['dark','light'].includes(value.theme)?value.theme:'system'};}catch{return{language:'zh-CN',theme:'system'};}}
const Context=createContext<{preferences:UiPreferences;setPreferences:(value:UiPreferences)=>void}>({preferences:{language:'zh-CN',theme:'system'},setPreferences:()=>{}});
export function UiPreferencesProvider({children}:{children:ReactNode}){
 const[preferences,setPreferences]=useState<UiPreferences>(read);
 useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(preferences));}catch{}const query=matchMedia('(prefers-color-scheme: dark)'),apply=()=>{document.documentElement.dataset.uiTheme=preferences.theme==='system'?(query.matches?'dark':'light'):preferences.theme;document.documentElement.lang=preferences.language;};apply();query.addEventListener('change',apply);return()=>query.removeEventListener('change',apply);},[preferences]);
 return <Context.Provider value={{preferences,setPreferences}}>{children}</Context.Provider>;
}
export function useUiPreferences(){const value=useContext(Context);return{...value,t:(zh:string,en:string)=>value.preferences.language==='en-US'?en:zh};}
